fn main() {
    #[cfg(feature = "windows-manifest")]
    {}
    let mut attrs = tauri_build::WindowsAttributes::new();
    if std::env::var("TARGET").map(|t| t.contains("windows")).unwrap_or(false) {
        attrs = attrs.app_manifest(include_str!("Capshot.manifest"));
    }
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(attrs))
        .expect("tauri build failed");
}
