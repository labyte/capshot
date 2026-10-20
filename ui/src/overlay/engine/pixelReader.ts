//! 单像素读取（放大镜）。
//!
//! 迁移前的写法是每个 pointermove 都 document.createElement("canvas") 开一张**全屏**
//! 画布（4K ≈ 33 MB）并 drawImage 整幅，只为 getImageData 取 1 个像素 —— 这是拖框卡顿的主因。
//! 这里改成：构造时铺一次离屏画布（willReadFrequently 走 CPU 后端，读像素不抢 GPU），
//! 之后只在坐标变化时做一次 1×1 getImageData，并按坐标缓存。

export class PixelReader {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly width: number;
  private readonly height: number;
  private key = -1;
  private rgb: [number, number, number] = [0, 0, 0];

  constructor(source: ImageBitmap | HTMLCanvasElement, width: number, height: number) {
    this.width = width;
    this.height = height;
    // 用游离的 HTMLCanvasElement 而不是 OffscreenCanvas：后者 getContext 返回
    // OffscreenCanvasRenderingContext2D，类型与 CanvasRenderingContext2D 不互通
    const off = document.createElement("canvas");
    off.width = width;
    off.height = height;
    const ctx = off.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2d context unavailable on pixel reader canvas");
    ctx.drawImage(source, 0, 0);
    this.ctx = ctx;
  }

  /** 越界返回 [0,0,0]，与迁移前 Frame::pixel 的语义一致 */
  at(x: number, y: number): [number, number, number] {
    const cx = Math.max(0, Math.min(this.width - 1, x | 0));
    const cy = Math.max(0, Math.min(this.height - 1, y | 0));
    const k = cy * this.width + cx;
    if (k !== this.key) {
      this.key = k;
      const d = this.ctx.getImageData(cx, cy, 1, 1).data;
      this.rgb = [d[0], d[1], d[2]];
    }
    return this.rgb;
  }

  hex(x: number, y: number): string {
    const [r, g, b] = this.at(x, y);
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
}
