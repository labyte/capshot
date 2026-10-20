fn main() {
    // Capshot.manifest 无条件注入（DPI awareness 等）；曾经挂过一个不存在的
    // `windows-manifest` feature 的 cfg 空块，那是死代码，已删。
    let mut attrs = tauri_build::WindowsAttributes::new();
    if std::env::var("TARGET").map(|t| t.contains("windows")).unwrap_or(false) {
        attrs = attrs.app_manifest(include_str!("Capshot.manifest"));
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(attrs))
        .expect("tauri build failed");
}
