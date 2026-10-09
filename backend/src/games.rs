//! Resolves the game name for a screenshot from Steam's local files, falling back to the store API.
//!
//! Screenshots live at `<steam>/userdata/<user>/760/remote/<game id>/screenshots/<file>`. The game id
//! is a Steam app id, or for non-Steam shortcuts a 32-bit id with the high bit set.

use std::{
  collections::HashMap,
  path::{Path, PathBuf},
  sync::{Mutex, OnceLock},
};

use serde::Deserialize;

const BUILTIN_APPS: &[(u64, &str)] = &[(7, "Steam")];
const SHORTCUT_ID_FLAG: u64 = 0x8000_0000;

static CACHE: OnceLock<Mutex<HashMap<u64, String>>> = OnceLock::new();

pub async fn resolve(game_id: u64, screenshot_path: &Path) -> Option<String> {
  let cache = CACHE.get_or_init(Default::default);
  if let Some(name) = cache.lock().ok()?.get(&game_id) {
    return Some(name.clone());
  }

  let name = match BUILTIN_APPS.iter().find(|(id, _)| *id == game_id) {
    Some((_, name)) => Some(name.to_string()),
    None => resolve_uncached(game_id, screenshot_path).await,
  };

  if let Some(name) = &name {
    cache.lock().ok()?.insert(game_id, name.clone());
  }

  name
}

async fn resolve_uncached(game_id: u64, screenshot_path: &Path) -> Option<String> {
  // <user>/760/remote/<game id>/screenshots/<file>
  let user_dir = screenshot_path.ancestors().nth(5)?;
  let steam_root = user_dir.parent()?.parent()?;

  if game_id >= SHORTCUT_ID_FLAG {
    return screenshot_shortcut_name(user_dir, game_id).or_else(|| shortcuts_vdf_name(user_dir, game_id));
  }

  if let Some(name) = app_manifest_name(steam_root, game_id) {
    return Some(name);
  }

  store_name(game_id).await
}

/// Steam records the names of non-Steam games it took screenshots of, keyed by screenshot folder id.
fn screenshot_shortcut_name(user_dir: &Path, game_id: u64) -> Option<String> {
  let text = std::fs::read_to_string(user_dir.join("760").join("screenshots.vdf")).ok()?;
  let root = parse_text_vdf(&text)?;
  root.get("screenshots")?.get("shortcutnames")?.get(&game_id.to_string())?.as_str().map(str::to_string)
}

fn shortcuts_vdf_name(user_dir: &Path, game_id: u64) -> Option<String> {
  let data = std::fs::read(user_dir.join("config").join("shortcuts.vdf")).ok()?;
  let root = BinaryVdfReader { data: &data, pos: 0 }.read_object()?;

  let shortcuts = match root.get("shortcuts")? {
    Vdf::Object(entries) => entries,
    Vdf::Str(_) => return None,
  };

  shortcuts.iter().find_map(|(_, shortcut)| {
    let app_id = shortcut.get("appid")?.as_str()?.parse::<u64>().ok()?;
    (app_id == game_id).then(|| shortcut.get("AppName")?.as_str().map(str::to_string)).flatten()
  })
}

fn app_manifest_name(steam_root: &Path, game_id: u64) -> Option<String> {
  let manifest = format!("appmanifest_{game_id}.acf");

  library_folders(steam_root).into_iter().find_map(|library| {
    let text = std::fs::read_to_string(library.join("steamapps").join(&manifest)).ok()?;
    parse_text_vdf(&text)?.get("AppState")?.get("name")?.as_str().map(str::to_string)
  })
}

fn library_folders(steam_root: &Path) -> Vec<PathBuf> {
  let mut folders = vec![steam_root.to_path_buf()];

  let text = std::fs::read_to_string(steam_root.join("steamapps").join("libraryfolders.vdf")).unwrap_or_default();
  if let Some(Vdf::Object(libraries)) = parse_text_vdf(&text).as_ref().and_then(|root| root.get("libraryfolders")) {
    for (_, library) in libraries {
      if let Some(path) = library.get("path").and_then(Vdf::as_str) {
        let path = PathBuf::from(path);
        if !folders.contains(&path) {
          folders.push(path);
        }
      }
    }
  }

  folders
}

#[derive(Deserialize)]
struct StoreResponse {
  data: Option<StoreData>,
}

#[derive(Deserialize)]
struct StoreData {
  name: String,
}

async fn store_name(game_id: u64) -> Option<String> {
  let url = format!("https://store.steampowered.com/api/appdetails?appids={game_id}&filters=basic");
  let payload: HashMap<String, StoreResponse> = reqwest::get(url).await.ok()?.json().await.ok()?;
  payload.get(&game_id.to_string())?.data.as_ref().map(|data| data.name.clone())
}

#[derive(Debug)]
enum Vdf {
  Str(String),
  Object(Vec<(String, Vdf)>),
}

impl Vdf {
  /// Case-insensitive key lookup, since Steam's casing of keys varies between files and versions.
  fn get(&self, key: &str) -> Option<&Vdf> {
    match self {
      Vdf::Object(entries) => entries.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v),
      Vdf::Str(_) => None,
    }
  }

  fn as_str(&self) -> Option<&str> {
    match self {
      Vdf::Str(s) => Some(s),
      Vdf::Object(_) => None,
    }
  }
}

fn parse_text_vdf(text: &str) -> Option<Vdf> {
  let mut tokens = Vec::new();
  let mut chars = text.chars().peekable();

  while let Some(c) = chars.next() {
    match c {
      '{' | '}' => tokens.push(c.to_string()),
      '"' => {
        let mut s = String::new();
        while let Some(c) = chars.next() {
          match c {
            '"' => break,
            '\\' => match chars.next() {
              Some('n') => s.push('\n'),
              Some('t') => s.push('\t'),
              Some(c) => s.push(c),
              None => break,
            },
            c => s.push(c),
          }
        }
        // Prefix quoted strings so a quoted "{" is never mistaken for a brace.
        tokens.push(format!("\"{s}"));
      }
      '/' if chars.peek() == Some(&'/') => {
        for c in chars.by_ref() {
          if c == '\n' {
            break;
          }
        }
      }
      _ => {}
    }
  }

  fn object(tokens: &[String], pos: &mut usize) -> Vec<(String, Vdf)> {
    let mut entries = Vec::new();
    while let Some(token) = tokens.get(*pos) {
      *pos += 1;
      let Some(key) = token.strip_prefix('"') else { break };
      match tokens.get(*pos).map(String::as_str) {
        Some("{") => {
          *pos += 1;
          entries.push((key.to_string(), Vdf::Object(object(tokens, pos))));
        }
        Some(value) if value.starts_with('"') => {
          *pos += 1;
          entries.push((key.to_string(), Vdf::Str(value[1..].to_string())));
        }
        _ => break,
      }
    }
    entries
  }

  Some(Vdf::Object(object(&tokens, &mut 0)))
}

struct BinaryVdfReader<'a> {
  data: &'a [u8],
  pos: usize,
}

impl BinaryVdfReader<'_> {
  fn read_object(&mut self) -> Option<Vdf> {
    let mut entries = Vec::new();
    loop {
      let kind = *self.data.get(self.pos)?;
      self.pos += 1;
      if kind == 0x08 {
        return Some(Vdf::Object(entries));
      }

      let key = self.read_string()?;
      let value = match kind {
        0x00 => self.read_object()?,
        0x01 => Vdf::Str(self.read_string()?),
        0x02 => Vdf::Str(u32::from_le_bytes(self.take::<4>()?).to_string()),
        0x07 => Vdf::Str(u64::from_le_bytes(self.take::<8>()?).to_string()),
        _ => return None,
      };
      entries.push((key, value));
    }
  }

  fn read_string(&mut self) -> Option<String> {
    let end = self.pos + self.data.get(self.pos..)?.iter().position(|&b| b == 0)?;
    let s = String::from_utf8_lossy(&self.data[self.pos..end]).into_owned();
    self.pos = end + 1;
    Some(s)
  }

  fn take<const N: usize>(&mut self) -> Option<[u8; N]> {
    let bytes = self.data.get(self.pos..self.pos + N)?.try_into().ok()?;
    self.pos += N;
    Some(bytes)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_text_vdf() {
    let root = parse_text_vdf(
      r#""AppState" { "appid" "1173820" "name" "FINAL FANTASY VI" "UserConfig" { "language" "english" } }"#,
    )
    .unwrap();
    assert_eq!(root.get("appstate").unwrap().get("name").unwrap().as_str(), Some("FINAL FANTASY VI"));
  }

  #[test]
  fn parses_binary_vdf() {
    let mut data = vec![0x00];
    data.extend(b"shortcuts\0");
    data.push(0x00);
    data.extend(b"0\0");
    data.push(0x02);
    data.extend(b"appid\0");
    data.extend(3_169_511_284u32.to_le_bytes());
    data.push(0x01);
    data.extend(b"AppName\0Lost Odyssey\0");
    data.extend([0x08, 0x08, 0x08]);

    let root = BinaryVdfReader { data: &data, pos: 0 }.read_object().unwrap();
    let shortcut = root.get("shortcuts").unwrap().get("0").unwrap();
    assert_eq!(shortcut.get("appid").unwrap().as_str(), Some("3169511284"));
    assert_eq!(shortcut.get("AppName").unwrap().as_str(), Some("Lost Odyssey"));
  }
}
