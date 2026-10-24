use std::path::{Path, PathBuf};

fn main() {
    // tauri-build 只对 tauri.conf.json 与 capabilities 目录发 rerun-if-changed，
    // 唯独不管 icons/。后果（真踩过）：改完 icons/icon.ico 连重编四次，托盘还是上一版的
    // 纯蓝旧图 —— build script 压根没重跑，out/resource.lib 停在图标改动之前 43 分钟。
    // 图标是编译期烘进 exe 的（winres → rc.exe → PE 里的 32512 资源），而 Windows 上
    // 托盘取的 default_window_icon() 正是这份资源，所以 build script 不重跑 = 永远看不到新图标。
    // icons 目录下新增文件（比如哪天补 icon.icns）要一起列进来。
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");

    ensure_rc();

    // Capshot.manifest 无条件注入（DPI awareness 等）；曾经挂过一个不存在的
    // `windows-manifest` feature 的 cfg 空块，那是死代码，已删。
    let mut attrs = tauri_build::WindowsAttributes::new();
    if std::env::var("TARGET").map(|t| t.contains("windows")).unwrap_or(false) {
        attrs = attrs.app_manifest(include_str!("Capshot.manifest"));
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(attrs))
        .expect("tauri build failed");
}

/// Windows 上 tauri-winres 要 rc.exe 编图标与 manifest 资源，找不到就直接 panic：
/// `Are you sure you have RC.EXE in your $PATH or ${RC_$TARGET} or $RC is set?`
/// —— `npm run tauri dev` 就是这么挂的（它内部照样跑 cargo）。以前只有 CI 有
/// 「Locate rc.exe」那一步，本地全靠人记得设 RC。这里把 CI 的找法搬进来，
/// 两边同一规则，本地不必再配环境变量。
fn ensure_rc() {
    let Ok(target) = std::env::var("TARGET") else { return };
    if !target.contains("windows") {
        return;
    }
    // 调用方指定的 RC（或 winres 认的 RC_<target>）优先，但**要真能用才让路**：
    // .cargo/config.toml 的 [env] 里挂着一条 `RC = "x86_64-w64-mingw32-windres"`，
    // 那是给 x86_64-pc-windows-gnu 用的，而 cargo 的 [env] 不分 target ——
    // 于是 MSVC 构建也被套上这台机器根本没装的 GNU windres，`npm run tauri dev` 就是这么挂的。
    println!("cargo:rerun-if-env-changed=RC");
    let preset = std::env::var_os("RC").or_else(|| std::env::var_os(format!("RC_{target}")));
    if let Some(v) = preset.clone() {
        if rc_usable(&v, &target) {
            return;
        }
        println!(
            "cargo:warning=RC={v:?} 对 target {target} 不可用（找不到该程序，或 MSVC 目标配了 GNU windres），\
             改走 Windows SDK 自动定位"
        );
    }
    match locate_rc() {
        Some(rc) => {
            // edition 2024 下 set_var 是 unsafe：build script 是独立单线程进程，
            // 此刻除了本线程没有任何人在读环境，写入安全。
            unsafe { std::env::set_var("RC", &rc) };
            // 进 target/debug/build/desktop-*/output，`cargo build -vv` 或直接读那个文件能看到
            println!("auto-located rc.exe: {}", rc.display());
        }
        None => println!(
            "cargo:warning=Windows SDK 的 x64/rc.exe 没找到（ProgramFiles 下 Windows Kits/10/bin 里没搜到），\
             嵌图标与 manifest 会失败。装 SDK 或手动设 RC 环境变量后重试。"
        ),
    }
}

/// 与 release.yml「Locate rc.exe」完全同规则：在 `%ProgramFiles(x86)%\Windows Kits\10\bin`
/// 下递归找路径以 `\x64\rc.exe` 结尾的文件，按完整路径**倒序**取第一个
/// （目录名是 10.0.xxxx.0 这种零填充版本串，倒序即最新版本优先）。
fn locate_rc() -> Option<PathBuf> {
    let mut found = rc_candidates();
    // 路径倒序：目录名是 10.0.xxxx.0 这种零填充版本串，倒序即最新 SDK 优先
    found.sort_by(|a, b| b.cmp(a));
    found.into_iter().next()
}

/// 调用方给的 RC 到底能不能用。
/// - MSVC 目标 + 名字里带 `windres`：本就是配错了（那是 GNU 工具链的资源编译器）
/// - 其余情况要求解析得到：直接是个文件，或在 PATH 里能找到（补 .exe 再试一次）
fn rc_usable(v: &std::ffi::OsStr, target: &str) -> bool {
    let p = PathBuf::from(v);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if target.ends_with("-msvc") && name.contains("windres") {
        return false;
    }
    if p.is_file() {
        return true;
    }
    let exe = format!("{name}.exe");
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .any(|dir| dir.join(&name).is_file() || dir.join(&exe).is_file())
}

fn rc_candidates() -> Vec<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    for key in ["ProgramFiles(x86)", "ProgramFiles"] {
        let Some(pf) = std::env::var_os(key) else { continue };
        let root = PathBuf::from(pf).join("Windows Kits").join("10").join("bin");
        walk(&root, 0, &mut found);
    }
    found
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    // 布局固定是 <版本>/<arch>/rc.exe，深度 3 足够，同时防止异常目录里递归失控
    if depth > 3 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            walk(&path, depth + 1, out);
        } else if path.to_string_lossy().to_lowercase().ends_with(r"\x64\rc.exe") {
            out.push(path);
        }
    }
}
