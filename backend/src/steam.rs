use std::{ffi::OsStr, path::{Path, PathBuf}, time::SystemTime};

use anyhow::anyhow;
use chrono::{DateTime, Local, NaiveDateTime};

use crate::{database::Db, games, Uploader};

pub struct GameScreenshot {
  pub game_id: u64,
  pub path: PathBuf,
  /// Name supplied by the caller (e.g. the Steam UI), which takes precedence over looking it up.
  pub known_game_name: Option<String>,
}

impl GameScreenshot {
  pub fn file_name(&self) -> Result<&OsStr, anyhow::Error> {
    self.path.file_name().ok_or_else(|| anyhow!("could not determine file name"))
  }

  pub async fn game_name(&self) -> Option<String> {
    let name = match &self.known_game_name {
      Some(name) => Some(name.clone()),
      None => games::resolve(self.game_id, &self.path).await,
    };
    name.map(|name| name.trim().to_string()).filter(|name| !name.is_empty())
  }

  /// "<game> <YYYY-MM-DD HH-MM-SS>.jpg", using the capture time from Steam's file name.
  pub fn upload_file_name(&self, game_name: Option<&str>, modified: SystemTime) -> String {
    let stem = self.path.file_stem().map(|stem| stem.to_string_lossy()).unwrap_or_default();
    let extension = self.path.extension().map(|ext| ext.to_string_lossy()).unwrap_or_else(|| "jpg".into());

    // Steam names screenshots "YYYYMMDDHHMMSS_N", where N counts shots taken in the same second.
    let (timestamp, sequence) = stem.split_once('_').unwrap_or((&stem, "1"));
    let taken = NaiveDateTime::parse_from_str(timestamp, "%Y%m%d%H%M%S")
      .unwrap_or_else(|_| DateTime::<Local>::from(modified).naive_local());

    let mut name = taken.format("%Y-%m-%d %H-%M-%S").to_string();
    if let Some(game) = game_name.map(sanitize_file_name).filter(|game| !game.is_empty()) {
      name = format!("{game} {name}");
    }
    if sequence.parse::<u32>().map_or(false, |n| n > 1) {
      name = format!("{name} ({sequence})");
    }

    format!("{name}.{extension}")
  }

  pub async fn upload(&self, uploader: &dyn Uploader, db: Db) -> Result<&GameScreenshot, anyhow::Error> {
    match uploader.upload(self).await {
      Ok(_) => Ok(self),

      Err(err) => match self.save(db).await {
        Ok(()) => Err(err),
        Err(save_err) => Err(save_err.context(err)),
      },
    }
  }

  pub async fn save(&self, db: Db) -> Result<(), anyhow::Error> {
    let mut db = db.lock().await;

    db.ladd("screenshots", &self.path.to_string_lossy()).ok_or_else(|| anyhow!("could not save screenshot"))?;

    Ok(())
  }
}

impl<P> From<P> for GameScreenshot
where
  P: AsRef<Path>,
{
  fn from(path: P) -> Self {
    let path = path.as_ref();
    let game_id = path.iter().rev().nth(2).and_then(|id| id.to_string_lossy().parse::<u64>().ok()).unwrap_or(0);

    GameScreenshot { game_id, path: path.to_owned(), known_game_name: None }
  }
}

/// Makes a game name safe to use in a file name on any OS.
fn sanitize_file_name(name: &str) -> String {
  let mut out = String::with_capacity(name.len());
  for c in name.chars() {
    match c {
      // "Half-Life 2: Episode One" reads better as "Half-Life 2 - Episode One".
      ':' => out.push_str(" -"),
      '/' | '\\' | '*' | '?' | '"' | '<' | '>' | '|' => out.push(' '),
      '\u{2122}' | '\u{00ae}' | '\u{00a9}' => {}
      c if c.is_control() => {}
      c => out.push(c),
    }
  }

  let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
  let trimmed = collapsed.trim_end_matches(['.', ' ']);
  trimmed.chars().take(120).collect::<String>().trim_end().to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn screenshot(file: &str) -> GameScreenshot {
    PathBuf::from(format!("/home/deck/.local/share/Steam/userdata/1/760/remote/3669870/screenshots/{file}")).into()
  }

  #[test]
  fn names_upload_with_game_and_date() {
    let shot = screenshot("20261007225406_1.jpg");
    assert_eq!(shot.upload_file_name(Some("CONTROL Resonant"), SystemTime::now()), "CONTROL Resonant 2026-10-07 22-54-06.jpg");
    assert_eq!(shot.upload_file_name(None, SystemTime::now()), "2026-10-07 22-54-06.jpg");
    assert_eq!(
      screenshot("20261007225406_2.jpg").upload_file_name(Some("Palworld"), SystemTime::now()),
      "Palworld 2026-10-07 22-54-06 (2).jpg"
    );
    assert_eq!(
      shot.upload_file_name(Some("Half-Life 2: Episode One"), SystemTime::now()),
      "Half-Life 2 - Episode One 2026-10-07 22-54-06.jpg"
    );
  }

  #[test]
  fn sanitizes_game_names() {
    assert_eq!(sanitize_file_name("Half-Life 2: Episode One"), "Half-Life 2 - Episode One");
    assert_eq!(sanitize_file_name("DOOM Eternal\u{2122}"), "DOOM Eternal");
    assert_eq!(sanitize_file_name("Fate/stay night"), "Fate stay night");
    assert_eq!(sanitize_file_name("Who Wants to Be a Millionaire?"), "Who Wants to Be a Millionaire");
    assert_eq!(sanitize_file_name("Mario Kart: Double Dash!!"), "Mario Kart - Double Dash!!");
  }
}
