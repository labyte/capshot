//! Windows.Graphics.Capture 单帧抓取（主路径）。
//! - 显示器：RoGetActivationFactory → IGraphicsCaptureItemInterop::CreateForMonitor
//! - 窗口：GraphicsCaptureItem::TryCreateFromWindowId(WindowId)（失败回退 interop CreateForWindow）
//! - SetIsBorderRequired(false) 关黄框（Win11；Win10 无此属性则黄框不可避免 —— 记录为已知差异）
//!   SetIsCursorCaptureEnabled(false)
//! - CreateFreeThreaded 帧池 + TryGetNextFrame 有界轮询；staging CPU_READ 拷贝；BGRA→RGBA
//! 失败 → Err，backend 回退 GDI/BitBlt。

use capture_core::error::{CaptureError, Result};
use capture_core::types::{Frame, PhysicalRect};
use std::time::{Duration, Instant};
use windows::core::{Interface, HSTRING};
use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Graphics::SizeInt32;
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::RoGetActivationFactory;
use windows::UI::WindowId;

const GRAPHICS_CAPTURE_ITEM_CLASS: &str = "Windows.Graphics.Capture.GraphicsCaptureItem";

fn perr(e: windows::core::Error) -> CaptureError {
    CaptureError::Platform { api: "wgc", os_status: format!("{e:?}") }
}

struct Device {
    d3d: ID3D11Device,
    ctx: ID3D11DeviceContext,
    winrt: IDirect3DDevice,
}

fn device() -> Result<Device> {
    unsafe {
        let levels = [D3D_FEATURE_LEVEL(D3D_FEATURE_LEVEL_11_0.0)];
        let mut dev: Option<ID3D11Device> = None;
        let mut got = D3D_FEATURE_LEVEL_11_0;
        let mut ctx: Option<ID3D11DeviceContext> = None;
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE(std::ptr::null_mut()),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut dev),
            Some(&mut got),
            Some(&mut ctx),
        )
        .map_err(perr)?;
        let d3d = dev.ok_or(CaptureError::BackendUnavailable("D3D11CreateDevice null device"))?;
        let ctx = ctx.ok_or(CaptureError::BackendUnavailable("D3D11CreateDevice null ctx"))?;
        let dxgi: IDXGIDevice = d3d.clone().cast().map_err(perr)?;
        let insp = CreateDirect3D11DeviceFromDXGIDevice(&dxgi).map_err(perr)?;
        let winrt: IDirect3DDevice = insp.cast().map_err(perr)?;
        Ok(Device { d3d, ctx, winrt })
    }
}

fn item_interop() -> Result<IGraphicsCaptureItemInterop> {
    unsafe {
        let class = HSTRING::from(GRAPHICS_CAPTURE_ITEM_CLASS);
        RoGetActivationFactory::<IGraphicsCaptureItemInterop>(&class).map_err(perr)
    }
}

fn item_for_monitor(hmon: HMONITOR) -> Result<GraphicsCaptureItem> {
    unsafe {
        let interop = item_interop()?;
        interop.CreateForMonitor(hmon).map_err(perr)
    }
}

fn item_for_window(hwnd: HWND) -> Result<GraphicsCaptureItem> {
    // 首选 WinRT 静态（Win10 1903+）；失败回退 interop
    unsafe {
        match GraphicsCaptureItem::TryCreateFromWindowId(WindowId { Value: hwnd.0 as u64 }) {
            Ok(item) => Ok(item),
            Err(_) => {
                let interop = item_interop()?;
                interop.CreateForWindow(hwnd).map_err(perr)
            }
        }
    }
}

fn grab_single(item: &GraphicsCaptureItem) -> Result<Frame> {
    let dev = device()?;
    unsafe {
        let size: SizeInt32 = item.Size().map_err(perr)?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &dev.winrt,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            1,
            size,
        )
        .map_err(perr)?;
        let session: GraphicsCaptureSession = pool.CreateCaptureSession(item).map_err(perr)?;
        // Win11 属性；Win10 上调用报错 → 忽略（黄框为已知平台差异）
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetIsCursorCaptureEnabled(false);
        session.StartCapture().map_err(perr)?;

        let deadline = Instant::now() + Duration::from_millis(500);
        let frame = loop {
            match pool.TryGetNextFrame() {
                Ok(f) => break f,
                Err(_) if Instant::now() >= deadline => {
                    return Err(CaptureError::BackendUnavailable("WGC frame timeout"))
                }
                Err(_) => std::thread::sleep(Duration::from_millis(2)),
            }
        };

        let surface = frame.Surface().map_err(perr)?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast().map_err(perr)?;
        let tex: ID3D11Texture2D = access.GetInterface().map_err(perr)?;
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        tex.GetDesc(&mut desc);
        let (w, h) = (desc.Width, desc.Height);
        let staging_desc = D3D11_TEXTURE2D_DESC {
            Width: w,
            Height: h,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_STAGING,
            BindFlags: 0,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            MiscFlags: 0,
        };
        let mut staging_opt: Option<ID3D11Texture2D> = None;
        dev.d3d.CreateTexture2D(&staging_desc, None, Some(&mut staging_opt)).map_err(perr)?;
        let staging = staging_opt.ok_or(CaptureError::BackendUnavailable("CreateTexture2D null"))?;
        dev.ctx.CopyResource(&staging, &tex);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        dev.ctx.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped as *mut _)).map_err(perr)?;
        let mut pixels = vec![0u8; w as usize * h as usize * 4];
        let src = mapped.pData as *const u8;
        let row = w as usize * 4;
        for y in 0..h as usize {
            let r = std::slice::from_raw_parts(src.add(y * mapped.RowPitch as usize), row);
            pixels[y * row..(y + 1) * row].copy_from_slice(r);
        }
        dev.ctx.Unmap(&staging, 0);
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        let _ = session.Close();
        let _ = pool.Close();
        Frame::new(w, h, row, pixels).ok_or(CaptureError::DegenerateGeometry("wgc frame size"))
    }
}

pub fn capture_monitor(hmon: HMONITOR) -> Result<Frame> {
    let item = item_for_monitor(hmon)?;
    grab_single(&item)
}

pub fn capture_window(hwnd: HWND, _expect: &PhysicalRect) -> Result<Frame> {
    let item = item_for_window(hwnd)?;
    grab_single(&item)
}

