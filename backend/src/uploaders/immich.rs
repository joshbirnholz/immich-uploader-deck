use anyhow::Context;
use reqwest::multipart;
use serde::Deserialize;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use crate::steam::GameScreenshot;
use crate::uploaders::Uploader;

#[derive(Clone, Deserialize)]
pub struct ImmichConfig {
    pub url: String,
    pub api_key: String,
    #[serde(default)]
    pub album_id: Option<String>,
}

#[derive(Deserialize)]
struct UploadResponse {
    id: String,
}

pub struct ImmichUploader {
    config: ImmichConfig,
    client: reqwest::Client,
}

impl ImmichUploader {
    pub fn build(config: ImmichConfig) -> Result<Self, anyhow::Error> {
        Ok(Self {
            config,
            client: reqwest::Client::new(),
        })
    }

    async fn add_to_album(&self, album_id: &str, asset_id: &str) -> Result<(), anyhow::Error> {
        let url = format!("{}/albums/{}/assets", self.config.url.trim_end_matches('/'), album_id);
        let response = self.client
            .put(url)
            .header("x-api-key", &self.config.api_key)
            .json(&serde_json::json!({ "ids": [asset_id] }))
            .send()
            .await
            .context("failed to send album request to Immich")?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("adding to Immich album failed with status {}: {}", status, text));
        }

        Ok(())
    }
}

#[async_trait]
impl Uploader for ImmichUploader {
    fn name(&self) -> &'static str {
        "Immich"
    }

    async fn upload<'a>(&'a self, screenshot: &'a GameScreenshot) -> Result<&'a GameScreenshot, anyhow::Error> {
        let file = File::open(&screenshot.path).await.context("could not open screenshot file")?;
        let metadata = file.metadata().await.context("could not get file metadata")?;
        let mtime = metadata.modified().context("could not get modification time")?;
        let iso_time = screenshot.captured_at.unwrap_or_else(|| mtime.into()).to_rfc3339();

        // deviceAssetId keeps Steam's own file name so it stays stable regardless of naming.
        let file_name = screenshot.file_name()?.to_string_lossy().to_string();
        let device_asset_id = format!("{}-{}", file_name, metadata.len());

        let game_name = screenshot.game_name().await;
        let upload_name = screenshot.upload_file_name(game_name.as_deref(), mtime);

        let stream = ReaderStream::new(file);
        let part = multipart::Part::stream(reqwest::Body::wrap_stream(stream))
            .file_name(upload_name.clone())
            .mime_str(screenshot.mime_type())?;

        let mut form = multipart::Form::new()
            .part("assetData", part)
            .text("deviceAssetId", device_asset_id)
            .text("deviceId", "SteamDeck")
            .text("fileCreatedAt", iso_time.clone())
            .text("fileModifiedAt", iso_time)
            .text("filename", upload_name.clone())
            .text("isFavorite", "false");

        // Immich has no description upload field, but reads the description from an XMP sidecar.
        if let Some(game_name) = &game_name {
            let sidecar = multipart::Part::text(description_sidecar(game_name))
                .file_name(format!("{upload_name}.xmp"))
                .mime_str("application/xml")?;
            form = form.part("sidecarData", sidecar);
        }

        let url = format!("{}/assets", self.config.url.trim_end_matches('/'));
        let response = self.client
            .post(url)
            .header("x-api-key", &self.config.api_key)
            .multipart(form)
            .send()
            .await
            .context("failed to send request to Immich")?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("Immich upload failed with status {}: {}", status, text));
        }

        // Duplicates come back with the existing asset's id, so a retried upload still lands in the album.
        let asset: UploadResponse = response.json().await.context("could not parse Immich upload response")?;

        if let Some(album_id) = self.config.album_id.as_deref().filter(|id| !id.is_empty()) {
            self.add_to_album(album_id, &asset.id).await?;
        }

        Ok(screenshot)
    }
}

fn description_sidecar(description: &str) -> String {
    let escaped = description
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;");

    format!(
        r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:description>
        <rdf:Alt>
          <rdf:li xml:lang="x-default">{escaped}</rdf:li>
        </rdf:Alt>
      </dc:description>
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#
    )
}
