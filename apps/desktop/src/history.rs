//! 历史存储：SQLite + PNG 原图 + JPEG 缩略图（计划 §6.3）。
//! 命名模板 {yyyy}-{MM}-{dd}_{HH}.{mm}.{ss}.{n}.{app} 复用 capture-core::filename。

use capture_core::{encode, filename, Frame, PhysicalRect};
use rusqlite::{params, Connection};
use serde::Serialize;

#[derive(Serialize)]
pub struct HistoryRow {
    pub id: i64,
    pub created_at: i64,
    pub width: u32,
    pub height: u32,
    pub source: String,
    pub app_hint: Option<String>,
    pub rect: PhysicalRect,
    pub thumb_base64: String,
}

pub struct HistoryStore {
    conn: Connection,
    root: std::path::PathBuf,
}

impl HistoryStore {
    pub fn open(root: std::path::PathBuf) -> rusqlite::Result<Self> {
        std::fs::create_dir_all(&root).ok();
        let conn = Connection::open(root.join("history.db"))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE IF NOT EXISTS captures(
               id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL,
               x INTEGER, y INTEGER, width INTEGER, height INTEGER,
               png_rel TEXT NOT NULL, thumb_rel TEXT,
               source TEXT NOT NULL, app_hint TEXT, annotation_json TEXT);
             CREATE INDEX IF NOT EXISTS idx_created ON captures(created_at DESC);",
        )?;
        Ok(Self { conn, root })
    }

    pub fn insert(
        &self,
        png: &[u8],
        thumb: &[u8],
        rect: &PhysicalRect,
        source: &str,
        app_hint: Option<&str>,
        annotation: Option<&str>,
        seq_day: u32,
        title_app: &str,
    ) -> Result<i64, String> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let (y, d) = {
            let secs = now;
            // 本地日期拆解交给 chrono-free 近似：直接存 UTC 分段，命名用 UTC（文档记录）
            let days = secs / 86400;
            let (yy, mm, dd) = epoch_days_to_date(days);
            (format!("{yy:04}"), format!("{yy:04}{mm:02}{dd:02}"))
        };
        let name = filename::render(
            filename::DEFAULT_TEMPLATE,
            &filename::Stamp {
                yyyy: y.parse().unwrap_or(1970),
                mm: d[4..6].parse().unwrap_or(1),
                dd: d[6..8].parse().unwrap_or(1),
                hh: ((secs_of_day(now) / 3600) % 24) as u8,
                min: ((secs_of_day(now) / 60) % 60) as u8,
                sec: (secs_of_day(now) % 60) as u8,
                seq: seq_day,
                app: Some(title_app),
                title: None,
            },
        );
        let png_rel = format!("history/{y}/{d}/{name}.png");
        let thumb_rel = format!("thumbnails/{name}.jpg");
        let png_path = self.root.join(&png_rel);
        let thumb_path = self.root.join(&thumb_rel);
        std::fs::create_dir_all(png_path.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(thumb_path.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&png_path, png).map_err(|e| e.to_string())?;
        // 缩略图失败不致命：主图与 DB 行才是历史的本体
        if let Err(e) = std::fs::write(&thumb_path, thumb) {
            log::warn!("thumbnail write failed: {e}");
        }
        self.conn.execute(
            "INSERT INTO captures(created_at,x,y,width,height,png_rel,thumb_rel,source,app_hint,annotation_json)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![now, rect.x, rect.y, rect.width, rect.height, png_rel, thumb_rel, source, app_hint, annotation],
        ).map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn day_seq(&self, day_key: &str) -> u32 {
        self.conn
            .query_row(
                "SELECT COUNT(*) FROM captures WHERE strftime('%Y%m%d', created_at, 'unixepoch') = ?1",
                params![day_key],
                |r| r.get(0),
            )
            .unwrap_or(0)
    }

    pub fn list(&self, limit: i64, offset: i64) -> Vec<HistoryRow> {
        let mut stmt = match self.conn.prepare(
            "SELECT id,created_at,x,y,width,height,png_rel,thumb_rel,source,app_hint
             FROM captures ORDER BY created_at DESC LIMIT ?1 OFFSET ?2",
        ) {
            Ok(s) => s,
            Err(_) => return Vec::new(),
        };
        let rows = stmt
            .query_map(params![limit, offset], |r| {
                let id: i64 = r.get(0)?;
                let ts: i64 = r.get(1)?;
                let rect = PhysicalRect::new(r.get(2)?, r.get(3)?, r.get::<_, i64>(4)?.max(0) as u32, r.get::<_, i64>(5)?.max(0) as u32);
                let thumb_rel: Option<String> = r.get(7)?;
                let thumb = thumb_rel
                    .as_ref()
                    .map(|p| std::fs::read(self.root.join(p)).unwrap_or_default())
                    .unwrap_or_default();
                Ok(HistoryRow {
                    id,
                    created_at: ts,
                    width: rect.width,
                    height: rect.height,
                    source: r.get(8)?,
                    app_hint: r.get(9)?,
                    rect,
                    thumb_base64: base64_encode(&thumb),
                })
            })
            .ok()
            .map(|it| it.filter_map(|x| x.ok()).collect())
            .unwrap_or_default();
        rows
    }

    pub fn png_path(&self, id: i64) -> Option<std::path::PathBuf> {
        let rel: String = self
            .conn
            .query_row("SELECT png_rel FROM captures WHERE id=?1", params![id], |r| r.get(0))
            .ok()?;
        Some(self.root.join(rel))
    }

    pub fn rect_of(&self, id: i64) -> Option<(i32, i32, u32, u32)> {
        self.conn
            .query_row("SELECT x,y,width,height FROM captures WHERE id=?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)?.max(1) as u32, r.get::<_, i64>(3)?.max(1) as u32))
            })
            .ok()
    }

    pub fn delete(&self, id: i64) {
        if let Some(p) = self.png_path(id) {
            let _ = std::fs::remove_file(p);
        }
        let rel: Option<String> = self
            .conn
            .query_row("SELECT thumb_rel FROM captures WHERE id=?1", params![id], |r| r.get(0))
            .ok()
            .flatten();
        if let Some(t) = rel {
            let _ = std::fs::remove_file(self.root.join(t));
        }
        let _ = self.conn.execute("DELETE FROM captures WHERE id=?1", params![id]);
    }

    /// 重编辑器读回标注 JSON。之前只有写入侧（set_annotation）且从未被调用，
    /// 所以整条「重新编辑」链路缺的就是这一环。
    pub fn annotation_of(&self, id: i64) -> Option<String> {
        self.conn
            .query_row("SELECT annotation_json FROM captures WHERE id=?1", params![id], |r| r.get(0))
            .ok()
            .flatten()
    }

    /// 就地更新某条历史的标注。当前导出策略是「重编辑另存为新条目」（已确认的决定），
    /// 所以这条路暂时没人调用；留着是给未来"覆盖原条目"模式的。
    #[allow(dead_code)]
    pub fn set_annotation(&self, id: i64, json: &str) {
        let _ = self.conn.execute(
            "UPDATE captures SET annotation_json=?2 WHERE id=?1",
            params![id, json],
        );
    }
}

/// UTC {yyyyMMdd}（历史 day_seq 与目录键共用；本地时区细化列入 M10）
pub fn epoch_day_key(ts: i64) -> String {
    let (y, m, d) = epoch_days_to_date(ts / 86400);
    format!("{y:04}{m:02}{d:02}")
}

/// 「另存为」对话框的默认文件名（UTC 时间戳 + .png），与历史留档命名同一模板。
pub fn default_save_name() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (yy, mm, dd) = epoch_days_to_date(now / 86400);
    let sod = secs_of_day(now);
    let name = filename::render(
        filename::DEFAULT_TEMPLATE,
        &filename::Stamp {
            yyyy: yy as u16,
            mm: mm as u8,
            dd: dd as u8,
            hh: (sod / 3600) as u8,
            min: ((sod / 60) % 60) as u8,
            sec: (sod % 60) as u8,
            seq: 1,
            app: None,
            title: None,
        },
    );
    format!("{name}.png")
}

fn secs_of_day(ts: i64) -> i64 {
    (ts % 86400 + 86400) % 86400
}

/// civil-from-days（Howard Hinnant 算法，无依赖日期换算）
fn epoch_days_to_date(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097).max(0);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2).max(0) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m.max(1) as u32, d.max(1) as u32)
}

pub fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn base64_decode(s: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).ok()
}

/// 从 PNG/位图字节生成 RGBA Frame（arboard 写入用）。
pub fn png_to_frame(bytes: &[u8]) -> Option<Frame> {
    let img = image::load_from_memory(bytes).ok()?.to_rgba8();
    let (w, h) = img.dimensions();
    Frame::new(w, h, w as usize * 4, img.into_raw())
}

#[allow(dead_code)]
pub fn frame_thumb(frame: &Frame) -> Vec<u8> {
    encode::to_thumbnail(frame).unwrap_or_default()
}
