# Let My Photos Go 🕊️

> *"Let my people go."* — Moses, ca. 1446 BC  
> *"Let my photos go."* — You, after discovering Google Takeout strips your GPS data.

---

## The Problem

You want your photos back. The real ones. With full EXIF data, GPS coordinates, and correct timestamps. But Google makes that surprisingly hard:

- **Google Takeout** gives you the files, but silently strips GPS coordinates and corrupts dates.
- **The Google Photos Library API** also strips GPS and doesn't serve original files — it serves transcoded versions.
- **[gphotosdl](https://github.com/gilesknap/gphotos-sync)** and friends are abandoned or broken.

## The Solution

`let-my-photos-go` bypasses all of this by automating the **Google Photos web interface** directly — just like you would if you sat down and downloaded each photo by hand, but at scale. Playwright drives a real Chromium browser that uses your actual Google session, so Google sees it as a normal user download and serves the original, untouched file.

The Google Photos API is still used — but only for **enumeration** (listing all your photos and their metadata). The actual downloads go through the browser, preserving every byte of EXIF data.

---

## Prerequisites

### 1. Google Cloud project with OAuth2 credentials

The Photos Library API requires a Google Cloud OAuth2 client to enumerate your library. This is a one-time setup.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or use an existing one).
2. Enable the **Photos Library API**: APIs & Services → Library → search "Photos Library API" → Enable.
3. Create credentials: APIs & Services → Credentials → Create Credentials → **OAuth client ID**.
   - Application type: **Desktop app**
   - Name: anything you like
4. Copy the **Client ID** and **Client Secret** — you'll need them when you first run `lmpg auth`.

> You may also need to add your Google account as a test user under OAuth consent screen → Test users, if the app is in "Testing" mode.

### 2. Node.js and Playwright

```bash
# Install dependencies
yarn install

# Install the Playwright Chromium browser (one-time)
npx playwright install chromium
```

---

## Installation

```bash
# From npm (once published)
npm install -g let-my-photos-go
npx playwright install chromium
```

Or run directly from source:

```bash
git clone https://github.com/gabrielgrijincu/let-my-photos-go
cd let-my-photos-go
yarn install
npx playwright install chromium
yarn build
yarn link  # makes `lmpg` available globally
```

---

## Usage

### Step 1: Log in to Google Photos (`lmpg auth`)

```bash
lmpg auth
```

Opens a visible Chromium browser window and navigates to `https://photos.google.com`. Log in to your Google account normally. Once you're in, come back to the terminal — the session is saved to `auth.json`. This browser session is what the tool uses to trigger downloads of original files, bypassing the API's transcoding.

### Step 2: Set up API access (`lmpg config`)

```bash
lmpg config
```

On first run, prompts for your Google Cloud OAuth2 **Client ID** and **Client Secret** and saves them to `config.json`. Then opens a Playwright browser window to Google's OAuth consent screen — authorize access to your photo library. The tool catches the redirect, exchanges the authorization code for tokens, and saves them to `tokens.json`.

These tokens are used to call the Photos Library API for fast enumeration of your entire library. Access tokens auto-refresh using the stored refresh token, so you rarely need to reauthenticate.

### Step 3: Download everything (`lmpg flee`)

```bash
lmpg flee
```

Launches a headless browser with the saved session, enumerates all your photos via the API, then downloads each one by triggering the "Download original" action (Shift+D) in the Google Photos web UI. Files are saved to `./photos/` by default.

Progress is checkpointed to `photos.db` (SQLite). If the run is interrupted, just run it again — already-downloaded photos are skipped automatically.

```bash
# Skip photos already marked as downloaded in the database
lmpg flee --resume

# Save to a custom directory
lmpg flee --output ~/Pictures/google-photos-backup
```

### Step 4: Check progress (`lmpg status`)

```bash
lmpg status
```

Shows total photos found, how many are downloaded, pending, and failed.

---

## How It Works

The tool separates two concerns that require different access methods:

| Concern | Method | Why |
|---|---|---|
| Listing your photos | Google Photos Library API (via OAuth2) | Fast, paginated, metadata-rich |
| Downloading originals | Playwright browser session (Shift+D) | Only way to get unmodified originals with full EXIF/GPS |

1. **`lmpg auth`** sets up OAuth2 tokens for the API and a Playwright browser session for downloads.
2. **`lmpg flee`** calls the API to enumerate all media items (paginated, `mediaItems.list`), inserts them into SQLite, then opens each photo's URL in the headless browser and triggers a download.
3. Each downloaded file is marked in `photos.db`. Re-runs skip already-completed photos.

---

## Files Created Locally

| File | Purpose | In `.gitignore`? |
|---|---|---|
| `config.json` | OAuth2 Client ID and Client Secret | ✅ Yes |
| `tokens.json` | OAuth2 access + refresh tokens | ✅ Yes |
| `auth.json` | Playwright browser session (cookies) | ✅ Yes |
| `photos.db` | SQLite checkpoint database | ✅ Yes |
| `photos/` | Downloaded photo files | ✅ Yes |

**None of these should ever be committed to git.** All are excluded by `.gitignore`.

`config.json` and `tokens.json` together grant full read access to your Google Photos library. `auth.json` contains your Google session cookies. Treat all of them like passwords.

---

## Session Expiry

- **`auth.json`** (browser session): expires periodically. When `lmpg flee` detects an invalid session, it will tell you to run `lmpg auth` again.
- **`tokens.json`** (API tokens): access tokens auto-refresh silently using the stored refresh token. Refresh tokens are long-lived but can be revoked via your [Google Account security page](https://myaccount.google.com/permissions).

---

## Commands

| Command | Description |
|---|---|
| `lmpg auth` | Log in to Google Photos (saves Playwright browser session) |
| `lmpg config` | Set up OAuth2 credentials and authorize API access |
| `lmpg flee` | Enumerate and download all photos |
| `lmpg flee --resume` | Skip photos already marked as downloaded |
| `lmpg flee --output <dir>` | Save to a custom directory (default: `./photos`) |
| `lmpg status` | Show download progress |
| `lmpg -v` | Print version |

---

## License

MIT
