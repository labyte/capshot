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
               png_rel TEXT NOT NULL, thumb_rel TEXT, src_rel TEXT,
               source TEXT NOT NULL, app_hint TEXT, annotation_json TEXT);
             CREATE INDEX IF NOT EXISTS idx_created ON captures(created_at DESC);",
        )?;
        // 老库补列：src_rel 存「未烘标注的原始底图」，重编辑要靠它才不会把标注画两遍。
        // 重复执行必然报 duplicate column，忽略即可（SQLite 没有 ADD COLUMN IF NOT EXISTS）。
        let _ = conn.execute("ALTER TABLE captures ADD COLUMN src_rel TEXT", []);
        Ok(Self { conn, root })
    }

    /// `png` = 烘好标注的成品图（缩略图/复制/贴图都读它）；
    /// `base_png` = 同一张截图的**未标注底图**，只在有标注时另存一份 `.src.png`。
    /// 重编辑必须从底图 + annotation_json 重新叠图形，否则标注会被画第二遍。
    pub fn insert(
        &self,
        png: &[u8],
        base_png: &[u8],
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
        // 底图与成品图字节相同 = 这张没有标注，不必多存一份。
        // 写失败也不能连累入库：降级成「没有独立底图」，重编辑按平面图处理（见 src_path）。
        let src_rel = if base_png.is_empty() || base_png == png {
            None
        } else {
            let rel = format!("history/{y}/{d}/{name}.src.png");
            let path = self.root.join(&rel);
            match std::fs::write(&path, base_png) {
                Ok(()) => Some(rel),
                Err(e) => {
                    log::warn!("history base png write failed: {e}");
                    None
                }
            }
        };
        // 缩略图失败不致命：主图与 DB 行才是历史的本体
        if let Err(e) = std::fs::write(&thumb_path, thumb) {
            log::warn!("thumbnail write failed: {e}");
        }
        self.conn.execute(
            "INSERT INTO captures(created_at,x,y,width,height,png_rel,thumb_rel,src_rel,source,app_hint,annotation_json)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
            params![now, rect.x, rect.y, rect.width, rect.height, png_rel, thumb_rel, src_rel, source, app_hint, annotation],
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

    /// 历史根目录（设置页「打开历史目录」用；库与 PNG 都在这下面）
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    pub fn png_path(&self, id: i64) -> Option<std::path::PathBuf> {
        let rel: String = self
            .conn
            .query_row("SELECT png_rel FROM captures WHERE id=?1", params![id], |r| r.get(0))
            .ok()?;
        Some(self.root.join(rel))
    }

    /// 重编辑用的**未烘标注底图**。老条目没有这一列（或底图文件已丢）就返回 None，
    /// 调用方按「成品图即底图」处理 —— 那种图上标注已经烘死在像素里，不能再叠一遍图形。
    pub fn src_path(&self, id: i64) -> Option<std::path::PathBuf> {
        let rel: Option<String> = self
            .conn
            .query_row("SELECT src_rel FROM captures WHERE id=?1", params![id], |r| r.get(0))
            .ok()
            .flatten();
        let path = self.root.join(rel?);
        path.is_file().then_some(path)
    }

    pub fn rect_of(&self, id: i64) -> Option<(i32, i32, u32, u32)> {
        self.conn
            .query_row("SELECT x,y,width,height FROM captures WHERE id=?1", params![id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get::<_, i64>(2)?.max(1) as u32, r.get::<_, i64>(3)?.max(1) as u32))
            })
            .ok()
    }

    /// 删一条：成品图、底图、缩略图三个文件 + DB 行。返回 DB 行是否真的删掉了。
    pub fn delete(&self, id: i64) -> bool {
        if let Some(p) = self.png_path(id) {
            let _ = std::fs::remove_file(p);
        }
        if let Some(p) = self.src_path(id) {
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
        self.conn
            .execute("DELETE FROM captures WHERE id=?1", params![id])
            .map(|n| n > 0)
            .unwrap_or(false)
    }

    /// 批量删（历史页多选）。逐条走 delete，文件与行一一对应，不搞半删半留。
    /// 返回真正删掉的条数，给前端报告「删了 N 条」而不是闷头刷新。
    pub fn delete_many(&self, ids: &[i64]) -> usize {
        ids.iter().filter(|id| self.delete(**id)).count()
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

/// 把 `dir/name.png` 落成一个**当前空闲**的路径：同秒内多次保存会撞名
/// （时间戳模板只到秒，seq 恒为 1），撞上就退到 `name-1.png`、`name-2.png`…
/// 直接覆盖会静默吞掉上一张图，所以宁可多带个序号。
pub fn unique_sibling(path: std::path::PathBuf) -> std::path::PathBuf {
    if !path.exists() {
        return path;
    }
    let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("capshot")
        .to_string();
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("png")
        .to_string();
    for i in 1..1000u32 {
        let cand = dir.join(format!("{stem}-{i}.{ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    path
}

fn secs_of_day(ts: i64) -> i64 {
    (ts % 86400 + 86400) % 86400
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 保存位置固定时，同一秒内连按两次保存不能互相覆盖
    #[test]
    fn unique_sibling_never_overwrites() {
        let dir = std::env::temp_dir().join(format!("capshot-unique-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = dir.join("shot.png");
        assert_eq!(unique_sibling(first.clone()), first);
        std::fs::write(&first, b"a").unwrap();
        let second = unique_sibling(first.clone());
        assert_eq!(second, dir.join("shot-1.png"));
        std::fs::write(&second, b"b").unwrap();
        assert_eq!(unique_sibling(first), dir.join("shot-2.png"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 有标注的条目要另存一份未烘标注的底图（重编辑从它重画图形）；
    /// 没标注的条目不能再存第二份；批量删除把成品图/底图/缩略图/DB 行一并清掉。
    #[test]
    fn base_png_split_and_batch_delete() {
        let root = std::env::temp_dir().join(format!("capshot-history-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let store = HistoryStore::open(root.clone()).unwrap();
        let rect = PhysicalRect::new(0, 0, 10, 10);

        let marked = store
            .insert(b"baked-1", b"base-1", b"thumb-1", &rect, "capture", None, Some("{\"v\":2,\"shapes\":[]}"), 1, "capshot")
            .unwrap();
        let plain = store
            .insert(b"same-2", b"same-2", b"thumb-2", &rect, "capture", None, None, 2, "capshot")
            .unwrap();

        // 成品图照旧是烘好的那张，底图单独一份
        assert_eq!(std::fs::read(store.png_path(marked).unwrap()).unwrap(), b"baked-1");
        let src = store.src_path(marked).expect("有空注时底图必须落盘");
        assert_eq!(std::fs::read(&src).unwrap(), b"base-1");
        // 字节相同 = 没有标注，不该多存一份
        assert!(store.src_path(plain).is_none());

        // 多选里混进一个已经被删掉的 id：只报真删掉的条数
        assert_eq!(store.delete_many(&[marked, plain, 999]), 2);
        assert!(!src.exists(), "批量删除要连底图一起删");
        assert!(store.list(10, 0).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
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
