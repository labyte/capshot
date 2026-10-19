//! 文件命名模板。token: {yyyy} {MM} {dd} {HH} {mm} {ss} {n} {app} {title}
//! sanitize 采用双平台安全交集字符集（Windows 保留字符一律剔除/替换）。

use crate::types::PhysicalRect;

pub const DEFAULT_TEMPLATE: &str = "{yyyy}-{MM}-{dd}_{HH}.{mm}.{ss}.{n}.{app}";

#[derive(Debug, Clone, Copy)]
pub struct Stamp<'a> {
    pub yyyy: u16,
    pub mm: u8,
    pub dd: u8,
    pub hh: u8,
    pub min: u8,
    pub sec: u8,
    pub seq: u32,
    pub app: Option<&'a str>,
    pub title: Option<&'a str>,
}

pub fn render(template: &str, s: &Stamp<'_>) -> String {
    let mut out = String::with_capacity(template.len() + 32);
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '{' {
            out.push(c);
            continue;
        }
        let mut token = String::new();
        let closed = loop {
            match chars.next() {
                Some('}') => break true,
                Some(x) => token.push(x),
                None => break false,
            }
        };
        if !closed {
            out.push('{');
            out.push_str(&token);
            continue;
        }
        match token.as_str() {
            "yyyy" => out.push_str(&format!("{:04}", s.yyyy)),
            "MM" => out.push_str(&format!("{:02}", s.mm)),
            "dd" => out.push_str(&format!("{:02}", s.dd)),
            "HH" => out.push_str(&format!("{:02}", s.hh)),
            "mm" => out.push_str(&format!("{:02}", s.min)),
            "ss" => out.push_str(&format!("{:02}", s.sec)),
            "n" => out.push_str(&format!("{:04}", s.seq)),
            "app" => out.push_str(&sanitize(s.app.unwrap_or("capshot"))),
            "title" => out.push_str(&sanitize(s.title.unwrap_or("capture"))),
            other => {
                out.push('{');
                out.push_str(other);
                out.push('}');
            }
        }
    }
    if out.is_empty() {
        out = format!("capture_{:04}", s.seq);
    }
    out
}

/// Windows 非法字符 <>:"/\|?* + 控制字符 + 前后空格/点；保留 Unicode 字母数字与 -_.
pub fn sanitize(raw: &str) -> String {
    let mut s: String = raw
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    while s.ends_with(' ') || s.ends_with('.') {
        s.pop();
    }
    while s.starts_with(' ') {
        s.remove(0);
    }
    let s: String = s.chars().take(120).collect();
    if s.is_empty() { "capture".to_string() } else { s }
}

/// 保存目录结构 history/{yyyy}/{yyyyMMdd}/ 的分段（与 history store 约定一致）
pub fn date_dirs(s: &Stamp<'_>) -> (String, String) {
    (format!("{:04}", s.yyyy), format!("{:04}{:02}{:02}", s.yyyy, s.mm, s.dd))
}

/// 选区描述（历史行 metadata）
pub fn rect_note(r: &PhysicalRect) -> String {
    format!("{}x{}@{},{}", r.width, r.height, r.x, r.y)
}
