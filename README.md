# Immich Uploader for Steam Deck

[English](#english) | [Deutsch](#deutsch)

---

<a name="english"></a>
## English

Immich Uploader is a service for your Steam Deck that automatically uploads any screenshot taken directly to your Immich instance.

### Features
- **Automatic Upload:** Screenshots are uploaded as soon as they are taken.
- **Immich Integration:** Dedicated support for Immich using its official API.
- **Offline Support:** Maintains an internal database to retry failed uploads when you're back online.
- **Share Menu:** Pick **Upload to Immich** from the Share menu in Steam's screenshot viewer to upload any screenshot.
- **Albums:** Optionally add every upload to an Immich album of your choice.
- **Game Names:** Uploads are named after the game and capture time (e.g. `CONTROL Resonant 2026-10-06 16-28-10.jpg`), including non-Steam games, and the game name is set as the photo's description.

### Configuration
1. **Log In:** Enter your Immich URL (e.g., `http://192.168.1.10:2283`), email and password and press **Log In**. The plugin creates an API key named "Steam Deck" that can only upload and add to albums, and saves it; your password is not stored. You can revoke the key anytime in Immich under Account Settings → API Keys.
2. **Album:** Optionally choose an album that uploads are added to.

### Installation
This plugin is designed for [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader).
1. Ensure you have the Rust toolchain and Node.js installed.
2. Build the frontend: `pnpm install && pnpm run build`
3. Build the backend: `cargo zigbuild --release --target x86_64-unknown-linux-gnu` inside `backend/`.
4. Deploy to `/home/deck/homebrew/plugins/immichuploader`.

---

<a name="deutsch"></a>
## Deutsch

Immich Uploader ist ein Dienst für das Steam Deck, der automatisch jeden Screenshot direkt auf deine Immich-Instanz hochlädt.

### Funktionen
- **Automatischer Upload:** Screenshots werden sofort nach der Aufnahme hochgeladen.
- **Immich Integration:** Dedizierte Unterstützung für Immich über die offizielle API.
- **Offline-Unterstützung:** Verwendet eine interne Datenbank, um fehlgeschlagene Uploads zu wiederholen, sobald du wieder online bist.
- **Teilen-Menü:** Wähle im Teilen-Menü der Steam-Screenshot-Ansicht **Upload to Immich**, um einen beliebigen Screenshot hochzuladen.
- **Alben:** Füge jeden Upload optional einem Immich-Album deiner Wahl hinzu.
- **Spielnamen:** Uploads werden nach Spiel und Aufnahmezeit benannt (z. B. `CONTROL Resonant 2026-10-06 16-28-10.jpg`), auch bei Nicht-Steam-Spielen, und der Spielname wird als Beschreibung des Fotos gesetzt.

### Konfiguration
1. **Anmeldung:** Gib deine Immich-URL (z. B. `http://192.168.1.10:2283`), E-Mail und Passwort ein und tippe auf **Log In**. Das Plugin erstellt einen API-Key namens „Steam Deck“, der nur hochladen und zu Alben hinzufügen darf, und speichert ihn; dein Passwort wird nicht gespeichert. Du kannst den Key jederzeit in Immich unter Kontoeinstellungen → API-Schlüssel widerrufen.
2. **Album:** Wähle optional ein Album, dem Uploads hinzugefügt werden.

### Installation
Dieses Plugin wurde für den [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) entwickelt.
1. Stelle sicher, dass Rust und Node.js installiert sind.
2. Frontend bauen: `pnpm install && pnpm run build`
3. Backend bauen: `cargo zigbuild --release --target x86_64-unknown-linux-gnu` im Ordner `backend/`.
4. Installation unter `/home/deck/homebrew/plugins/immichuploader`.

---

## Credits
Built by **R. Schlensog + AI Support / KI Unterstützung**.

## License
MIT
