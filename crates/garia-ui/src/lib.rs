//! iced shell for Garia.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use garia_core::aria2::{self, Engine, QueueRow, QueueSnapshot};
use garia_core::catch::CatchEvent;
use garia_core::ftp;
use garia_core::settings::Settings;
use garia_core::video::{self, Probe, Video};
use garia_platform::{Platform, PlatformEvent, TrayAction, UpdateInfo};
use iced::widget::{
    button, column, container, row, scrollable, text, text_input, Space,
};
use iced::{Alignment, Element, Fill, Length, Subscription, Task, Theme};

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone)]
pub struct EngineHandle {
    pub inner: Arc<Engine>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Queue,
    Add,
    Settings,
}

pub struct App {
    engine: EngineHandle,
    platform: Platform,
    screen: Screen,
    queue: QueueSnapshot,
    download_dir: String,
    status: String,
    saving: bool,
    add_url: String,
    catch_pending: Option<CatchEvent>,
    autostart: bool,
    catch_clipboard: bool,
    update: Option<UpdateInfo>,
    update_status: String,
    ftp_url: String,
    ftp_status: String,
    ftp_entries: Vec<String>,
    video_url: String,
    video_status: String,
    video: Arc<Video>,
}

#[derive(Debug, Clone)]
pub enum Message {
    Tick,
    PlatformTick,
    QueuePolled(QueueSnapshot),
    Navigate(Screen),
    DownloadDirChanged(String),
    BrowseDownloadDir,
    SaveSettings,
    SettingsSaved(Result<(Settings, bool), String>),
    AddUrlChanged(String),
    SubmitAdd,
    AddDone(Result<String, String>),
    CatchOffer(CatchEvent),
    CatchAccept,
    CatchDismiss,
    OpenTorrent(PathBuf),
    TorrentQueued(Result<String, String>),
    Tray(TrayAction),
    ToggleAutostart(bool),
    AutostartSet(Result<bool, String>),
    CheckUpdate,
    ToggleCatchClipboard,
    UpdateChecked(Result<Option<UpdateInfo>, String>),
    RevealDownloads,
    FtpUrlChanged(String),
    FtpList,
    FtpListed(Result<ftp::FtpListing, String>),
    QueueFtp(String),
    VideoUrlChanged(String),
    VideoProbe,
    VideoProbed(Result<Probe, String>),
    PauseAll,
    ResumeAll,
    Quit,
}

impl App {
    pub fn new(
        engine: Engine,
        platform: Platform,
        zipapp: Option<PathBuf>,
    ) -> (Self, Task<Message>) {
        let settings = engine
            .settings
            .current
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default();
        let download_dir = settings.download_dir.clone();
        platform.set_download_dir(PathBuf::from(&download_dir));
        let autostart = platform.autostart_enabled().unwrap_or(false);
        let handle = EngineHandle {
            inner: Arc::new(engine),
        };
        let app = Self {
            engine: handle.clone(),
            platform,
            screen: Screen::Queue,
            queue: QueueSnapshot::default(),
            download_dir,
            status: "Starting…".into(),
            saving: false,
            add_url: String::new(),
            catch_pending: None,
            autostart,
            catch_clipboard: settings.catch_clipboard,
            update: None,
            update_status: String::new(),
            ftp_url: String::new(),
            ftp_status: String::new(),
            ftp_entries: Vec::new(),
            video_url: String::new(),
            video_status: String::new(),
            video: Arc::new(Video {
                zipapp,
                resolved: std::sync::Mutex::new(None),
                tools: std::sync::Mutex::new(None),
            }),
        };
        (app, poll_now(handle))
    }

    pub fn title(&self) -> String {
        let n = self.queue.active + self.queue.waiting;
        if n == 0 {
            "Garia".into()
        } else {
            format!("Garia — {n}")
        }
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Tick => poll_now(self.engine.clone()),
            Message::PlatformTick => self.drain_platform(),
            Message::QueuePolled(snap) => {
                if let Some(err) = &snap.error {
                    self.status = format!("aria2 unreachable — {err}");
                } else {
                    self.status = format!(
                        "{} active · {} waiting · {} stopped",
                        snap.active, snap.waiting, snap.stopped
                    );
                    self.platform.set_active_count(snap.active);
                    self.platform.set_badge(snap.stopped.min(99));
                }
                self.queue = snap;
                Task::none()
            }
            Message::Navigate(screen) => {
                self.screen = screen;
                Task::none()
            }
            Message::DownloadDirChanged(dir) => {
                self.download_dir = dir;
                Task::none()
            }
            Message::BrowseDownloadDir => {
                if let Some(path) = self.platform.pick_folder() {
                    self.download_dir = path.display().to_string();
                }
                Task::none()
            }
            Message::SaveSettings => {
                self.saving = true;
                let engine = self.engine.clone();
                let platform = self.platform.clone();
                let dir = self.download_dir.clone();
                let catch_clipboard = self.catch_clipboard;
                Task::perform(
                    async move {
                        tokio::task::spawn_blocking(move || {
                            save_settings(&engine, &platform, dir, catch_clipboard)
                        })
                        .await
                        .map_err(|e| e.to_string())?
                    },
                    Message::SettingsSaved,
                )
            }
            Message::SettingsSaved(result) => {
                self.saving = false;
                match result {
                    Ok((settings, _)) => {
                        self.download_dir = settings.download_dir;
                        self.catch_clipboard = settings.catch_clipboard;
                        self.status = "Settings saved".into();
                        self.platform.notify("Garia", "Settings saved");
                    }
                    Err(e) => self.status = format!("Could not save settings: {e}"),
                }
                Task::none()
            }
            Message::AddUrlChanged(url) => {
                self.add_url = url;
                Task::none()
            }
            Message::SubmitAdd => {
                let url = self.add_url.trim().to_string();
                if url.is_empty() {
                    return Task::none();
                }
                let engine = self.engine.clone();
                Task::perform(
                    async move {
                        tokio::task::spawn_blocking(move || add_uri(&engine, &url))
                            .await
                            .map_err(|e| e.to_string())?
                    },
                    Message::AddDone,
                )
            }
            Message::AddDone(result) => {
                match result {
                    Ok(gid) => {
                        self.status = format!("Queued {gid}");
                        self.add_url.clear();
                        self.screen = Screen::Queue;
                        self.platform.notify("Garia", "Download queued");
                    }
                    Err(e) => self.status = format!("Could not add: {e}"),
                }
                Task::none()
            }
            Message::CatchOffer(event) => {
                if self.catch_clipboard || event.source != "clipboard" {
                    self.catch_pending = Some(event);
                    self.screen = Screen::Add;
                }
                Task::none()
            }
            Message::CatchAccept => {
                if let Some(event) = self.catch_pending.take() {
                    let engine = self.engine.clone();
                    let url = event.url.clone();
                    return Task::perform(
                        async move {
                            tokio::task::spawn_blocking(move || add_uri(&engine, &url))
                                .await
                                .map_err(|e| e.to_string())?
                        },
                        Message::AddDone,
                    );
                }
                Task::none()
            }
            Message::CatchDismiss => {
                self.catch_pending = None;
                Task::none()
            }
            Message::OpenTorrent(path) => {
                let engine = self.engine.clone();
                Task::perform(
                    async move {
                        tokio::task::spawn_blocking(move || add_torrent(&engine, &path))
                            .await
                            .map_err(|e| e.to_string())?
                    },
                    Message::TorrentQueued,
                )
            }
            Message::TorrentQueued(result) => {
                match result {
                    Ok(gid) => {
                        self.status = format!("Torrent queued {gid}");
                        self.platform.notify("Garia", "Torrent queued");
                    }
                    Err(e) => self.status = format!("Torrent error: {e}"),
                }
                Task::none()
            }
            Message::Tray(action) => self.handle_tray(action),
            Message::ToggleAutostart(on) => {
                let platform = self.platform.clone();
                Task::perform(
                    async move {
                        tokio::task::spawn_blocking(move || {
                            platform.set_autostart(on)?;
                            Ok(on)
                        })
                        .await
                        .map_err(|e| e.to_string())?
                    },
                    Message::AutostartSet,
                )
            }
            Message::AutostartSet(result) => {
                match result {
                    Ok(on) => {
                        self.autostart = on;
                        self.update_status = if on {
                            "Launch at login on".into()
                        } else {
                            "Launch at login off".into()
                        };
                    }
                    Err(e) => self.update_status = e,
                }
                Task::none()
            }
            Message::CheckUpdate => {
                self.update_status = "Checking…".into();
                let platform = self.platform.clone();
                Task::perform(
                    async move {
                        tokio::task::spawn_blocking(move || {
                            platform.check_for_update(APP_VERSION)
                        })
                        .await
                        .map_err(|e| e.to_string())?
                    },
                    Message::UpdateChecked,
                )
            }
            Message::UpdateChecked(result) => {
                match result {
                    Ok(Some(info)) => {
                        self.update_status =
                            format!("Update {} available (you have {})", info.version, info.current_version);
                        self.update = Some(info);
                    }
                    Ok(None) => {
                        self.update = None;
                        self.update_status = format!("Up to date ({APP_VERSION})");
                    }
                    Err(e) => {
                        self.update = None;
                        self.update_status = e;
                    }
                }
                Task::none()
            }
            Message::RevealDownloads => {
                let dir = PathBuf::from(&self.download_dir);
                if let Err(e) = self.platform.reveal(&dir) {
                    self.status = e;
                }
                Task::none()
            }
            Message::FtpUrlChanged(url) => {
                self.ftp_url = url;
                Task::none()
            }
            Message::FtpList => {
                let url = self.ftp_url.clone();
                self.ftp_status = "Listing…".into();
                Task::perform(
                    async move {
                        tokio::task::spawn_blocking(move || {
                            let target = ftp::parse_ftp_url(&url)?;
                            ftp::list_directory(&target, None)
                        })
                        .await
                        .map_err(|e| e.to_string())?
                    },
                    Message::FtpListed,
                )
            }
            Message::FtpListed(result) => {
                match result {
                    Ok(listing) => {
                        self.ftp_status = format!(
                            "{} — {} entries{}",
                            listing.path,
                            listing.entries.len(),
                            if listing.truncated { " (truncated)" } else { "" }
                        );
                        self.ftp_entries = listing
                            .entries
                            .into_iter()
                            .filter(|e| !e.dir)
                            .map(|e| e.url)
                            .collect();
                    }
                    Err(e) => {
                        self.ftp_status = e;
                        self.ftp_entries.clear();
                    }
                }
                Task::none()
            }
            Message::QueueFtp(url) => {
                let engine = self.engine.clone();
                Task::perform(
                    async move {
                        tokio::task::spawn_blocking(move || add_uri(&engine, &url))
                            .await
                            .map_err(|e| e.to_string())?
                    },
                    Message::AddDone,
                )
            }
            Message::VideoUrlChanged(url) => {
                self.video_url = url;
                Task::none()
            }
            Message::VideoProbe => {
                let video = self.video.clone();
                let engine = self.engine.clone();
                let url = self.video_url.clone();
                self.video_status = "Probing…".into();
                Task::perform(
                    async move {
                        tokio::task::spawn_blocking(move || {
                            video::video_probe_blocking(&video, &engine.inner.settings, url)
                        })
                        .await
                        .map_err(|e| e.to_string())?
                    },
                    Message::VideoProbed,
                )
            }
            Message::VideoProbed(result) => {
                match result {
                    Ok(Probe::Video(info)) => {
                        self.video_status = format!(
                            "{} — {} formats",
                            info.title,
                            info.formats.len()
                        );
                        // Queue best complete or first format for MVP.
                        if let Some(fmt) = info
                            .formats
                            .iter()
                            .find(|f| f.kind == "complete")
                            .or_else(|| info.formats.first())
                        {
                            let engine = self.engine.clone();
                            let url = fmt.url.clone();
                            return Task::perform(
                                async move {
                                    tokio::task::spawn_blocking(move || add_uri(&engine, &url))
                                        .await
                                        .map_err(|e| e.to_string())?
                                },
                                Message::AddDone,
                            );
                        }
                    }
                    Ok(Probe::Playlist(list)) => {
                        self.video_status =
                            format!("Playlist “{}” — {} entries (open a single video)", list.title, list.total);
                    }
                    Err(e) => self.video_status = e,
                }
                Task::none()
            }
            Message::PauseAll => rpc_all(self.engine.clone(), "aria2.pauseAll"),
            Message::ResumeAll => rpc_all(self.engine.clone(), "aria2.unpauseAll"),
            Message::ToggleCatchClipboard => {
                self.catch_clipboard = !self.catch_clipboard;
                Task::none()
            }
            Message::Quit => iced::exit(),
        }
    }

    fn handle_tray(&mut self, action: TrayAction) -> Task<Message> {
        match action {
            TrayAction::Show => Task::none(),
            TrayAction::NewDownload => {
                self.screen = Screen::Add;
                Task::none()
            }
            TrayAction::PauseAll => rpc_all(self.engine.clone(), "aria2.pauseAll"),
            TrayAction::ResumeAll => rpc_all(self.engine.clone(), "aria2.unpauseAll"),
            TrayAction::OpenFolder => {
                let dir = PathBuf::from(&self.download_dir);
                let _ = self.platform.reveal(&dir);
                Task::none()
            }
            TrayAction::Quit => iced::exit(),
        }
    }

    fn drain_platform(&mut self) -> Task<Message> {
        self.platform.pump_tray_menus();
        let mut tasks = Vec::new();
        while let Some(ev) = self.platform.try_recv() {
            match ev {
                PlatformEvent::Tray(action) => tasks.push(Task::done(Message::Tray(action))),
                PlatformEvent::Catch(event) => tasks.push(Task::done(Message::CatchOffer(event))),
                PlatformEvent::OpenTorrent(path) => {
                    tasks.push(Task::done(Message::OpenTorrent(path)))
                }
                PlatformEvent::DeepLink(link) => {
                    if let Some(event) = garia_core::catch::catch_from_garia_link(&link) {
                        tasks.push(Task::done(Message::CatchOffer(event)));
                    } else if let Some(url) = garia_core::catch::magnet_url(&link) {
                        tasks.push(Task::done(Message::CatchOffer(CatchEvent {
                            url,
                            source: "scheme".into(),
                            name: None,
                            referrer: None,
                            confirm: false,
                            urls: Vec::new(),
                        })));
                    }
                }
            }
        }
        Task::batch(tasks)
    }

    pub fn subscription(&self) -> Subscription<Message> {
        Subscription::batch([
            iced::time::every(Duration::from_secs(1)).map(|_| Message::Tick),
            iced::time::every(Duration::from_millis(250)).map(|_| Message::PlatformTick),
        ])
    }

    pub fn view(&self) -> Element<'_, Message> {
        let nav = row![
            nav_btn("Queue", Screen::Queue, self.screen),
            nav_btn("Add", Screen::Add, self.screen),
            nav_btn("Settings", Screen::Settings, self.screen),
            Space::with_width(Fill),
            button("Pause all").on_press(Message::PauseAll).padding([6, 10]),
            button("Resume all").on_press(Message::ResumeAll).padding([6, 10]),
            button("Folder").on_press(Message::RevealDownloads).padding([6, 10]),
        ]
        .spacing(8)
        .align_y(Alignment::Center);

        let body: Element<'_, Message> = match self.screen {
            Screen::Queue => self.view_queue(),
            Screen::Add => self.view_add(),
            Screen::Settings => self.view_settings(),
        };

        container(
            column![
                text("Garia").size(28),
                text(&self.status).size(13),
                Space::with_height(Length::Fixed(8.0)),
                nav,
                Space::with_height(Length::Fixed(12.0)),
                body,
            ]
            .spacing(4)
            .padding(20),
        )
        .width(Fill)
        .height(Fill)
        .into()
    }

    fn view_queue(&self) -> Element<'_, Message> {
        let header = row![
            text("Name").width(Fill),
            text("Status").width(90),
            text("Progress").width(110),
            text("Speed").width(90),
        ]
        .spacing(8)
        .padding([0, 4]);

        let rows: Element<'_, Message> = if self.queue.rows.is_empty() {
            text(if self.queue.error.is_some() {
                "No downloads — aria2 is not answering."
            } else {
                "No downloads in the queue."
            })
            .size(14)
            .into()
        } else {
            column(self.queue.rows.iter().map(queue_row_view).collect::<Vec<_>>())
                .spacing(2)
                .into()
        };

        column![text("Queue").size(18), header, scrollable(rows).height(Fill)]
            .spacing(6)
            .into()
    }

    fn view_add(&self) -> Element<'_, Message> {
        let mut col = column![
            text("Add download").size(18),
            row![
                text_input("https://… or magnet:…", &self.add_url)
                    .on_input(Message::AddUrlChanged)
                    .on_submit(Message::SubmitAdd)
                    .padding(8)
                    .width(Fill),
                button("Add").on_press(Message::SubmitAdd).padding([8, 14]),
            ]
            .spacing(8),
        ]
        .spacing(8);

        if let Some(catch) = &self.catch_pending {
            col = col.push(
                container(
                    column![
                        text(format!("Caught from {}", catch.source)).size(14),
                        text(&catch.url).size(13),
                        row![
                            button("Download")
                                .on_press(Message::CatchAccept)
                                .padding([6, 12]),
                            button("Dismiss")
                                .on_press(Message::CatchDismiss)
                                .padding([6, 12]),
                        ]
                        .spacing(8),
                    ]
                    .spacing(6),
                )
                .padding(12),
            );
        }

        col = col.push(Space::with_height(Length::Fixed(16.0)));
        col = col.push(text("FTP browse").size(16));
        col = col.push(
            row![
                text_input("ftp://host/path", &self.ftp_url)
                    .on_input(Message::FtpUrlChanged)
                    .padding(8)
                    .width(Fill),
                button("List").on_press(Message::FtpList).padding([8, 14]),
            ]
            .spacing(8),
        );
        col = col.push(text(&self.ftp_status).size(13));
        if !self.ftp_entries.is_empty() {
            let entries = column(
                self.ftp_entries
                    .iter()
                    .take(40)
                    .map(|url| {
                        button(text(url).size(12))
                            .on_press(Message::QueueFtp(url.clone()))
                            .padding(4)
                            .into()
                    })
                    .collect::<Vec<Element<'_, Message>>>(),
            )
            .spacing(2);
            col = col.push(scrollable(entries).height(Length::Fixed(140.0)));
        }

        col = col.push(Space::with_height(Length::Fixed(16.0)));
        col = col.push(text("Video page (yt-dlp)").size(16));
        col = col.push(
            row![
                text_input("https://…", &self.video_url)
                    .on_input(Message::VideoUrlChanged)
                    .padding(8)
                    .width(Fill),
                button("Probe & queue")
                    .on_press(Message::VideoProbe)
                    .padding([8, 14]),
            ]
            .spacing(8),
        );
        col = col.push(text(&self.video_status).size(13));

        scrollable(col.spacing(8)).height(Fill).into()
    }

    fn view_settings(&self) -> Element<'_, Message> {
        let save_btn = if self.saving {
            button("Saving…").padding([8, 14])
        } else {
            button("Save").on_press(Message::SaveSettings).padding([8, 14])
        };

        let update_line: Element<'_, Message> = if let Some(info) = &self.update {
            column![
                text(&self.update_status).size(13),
                text(&info.notes).size(12),
                text(
                    info.url
                        .as_deref()
                        .map(|u| format!("Download: {u}"))
                        .unwrap_or_default(),
                )
                .size(12),
            ]
            .spacing(4)
            .into()
        } else {
            text(&self.update_status).size(13).into()
        };

        column![
            text("Settings").size(18),
            text("Download folder").size(14),
            row![
                text_input("/path", &self.download_dir)
                    .on_input(Message::DownloadDirChanged)
                    .padding(8)
                    .width(Fill),
                button("Browse…")
                    .on_press(Message::BrowseDownloadDir)
                    .padding([8, 12]),
                save_btn,
            ]
            .spacing(8),
            Space::with_height(Length::Fixed(12.0)),
            row![
                text("Launch at login").width(Fill),
                button(if self.autostart { "On" } else { "Off" })
                    .on_press(Message::ToggleAutostart(!self.autostart))
                    .padding([6, 12]),
            ]
            .align_y(Alignment::Center),
            row![
                text("Watch clipboard for file URLs").width(Fill),
                button(if self.catch_clipboard { "On" } else { "Off" })
                    .on_press(Message::ToggleCatchClipboard)
                    .padding([6, 12]),
            ]
            .align_y(Alignment::Center),
            Space::with_height(Length::Fixed(12.0)),
            row![
                button("Check for updates")
                    .on_press(Message::CheckUpdate)
                    .padding([8, 12]),
                text(format!("v{APP_VERSION}")).size(13),
            ]
            .spacing(12)
            .align_y(Alignment::Center),
            update_line,
        ]
        .spacing(8)
        .into()
    }

    pub fn theme(&self) -> Theme {
        Theme::Light
    }
}

// Fix catch clipboard toggle properly in view_settings — the placeholder is wrong.
// I'll patch after writing helper fns.

fn nav_btn<'a>(label: &'a str, screen: Screen, current: Screen) -> Element<'a, Message> {
    let btn = button(label).on_press(Message::Navigate(screen)).padding([6, 12]);
    if screen == current {
        btn.style(iced::widget::button::primary).into()
    } else {
        btn.into()
    }
}

fn queue_row_view(row: &QueueRow) -> Element<'_, Message> {
    let progress = if row.total > 0 {
        format!("{:.0}%", (row.completed as f64 / row.total as f64) * 100.0)
    } else {
        "—".into()
    };
    container(
        row![
            text(&row.name).width(Fill),
            text(&row.status).width(90),
            text(progress).width(110),
            text(format_speed(row.download_speed)).width(90),
        ]
        .spacing(8)
        .align_y(Alignment::Center),
    )
    .padding([6, 4])
    .into()
}

fn poll_now(engine: EngineHandle) -> Task<Message> {
    Task::perform(
        async move {
            let port = engine.inner.aria2.port;
            let secret = engine.inner.aria2.secret();
            tokio::task::spawn_blocking(move || aria2::poll_queue(port, &secret))
                .await
                .unwrap_or_else(|e| QueueSnapshot {
                    error: Some(e.to_string()),
                    ..Default::default()
                })
        },
        Message::QueuePolled,
    )
}

fn rpc_all(engine: EngineHandle, method: &'static str) -> Task<Message> {
    Task::perform(
        async move {
            let port = engine.inner.aria2.port;
            let secret = engine.inner.aria2.secret();
            tokio::task::spawn_blocking(move || {
                aria2::aria2_request(port, &secret, method, serde_json::json!([]))?;
                Ok(method.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        },
        Message::AddDone,
    )
}

fn save_settings(
    engine: &EngineHandle,
    platform: &Platform,
    dir: String,
    catch_clipboard: bool,
) -> Result<(Settings, bool), String> {
    let mut settings = engine
        .inner
        .settings
        .current
        .lock()
        .map(|s| s.clone())
        .map_err(|_| "could not read settings".to_string())?;
    settings.download_dir = dir.clone();
    settings.catch_clipboard = catch_clipboard;
    let saved = aria2::save_settings(&engine.inner.aria2, &engine.inner.settings, settings)?;
    platform.set_download_dir(PathBuf::from(&saved.download_dir));
    Ok((saved, catch_clipboard))
}

fn add_uri(engine: &EngineHandle, url: &str) -> Result<String, String> {
    let port = engine.inner.aria2.port;
    let secret = engine.inner.aria2.secret();
    let dir = engine
        .inner
        .settings
        .current
        .lock()
        .map(|s| s.download_dir.clone())
        .unwrap_or_default();
    let opts = serde_json::json!({ "dir": dir });
    let out = aria2::aria2_request(
        port,
        &secret,
        "aria2.addUri",
        serde_json::json!([[url], opts]),
    )?;
    out.get("result")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "aria2 did not return a gid".into())
}

fn add_torrent(engine: &EngineHandle, path: &PathBuf) -> Result<String, String> {
    let b64 = aria2::read_torrent(path.display().to_string())?;
    let port = engine.inner.aria2.port;
    let secret = engine.inner.aria2.secret();
    let dir = engine
        .inner
        .settings
        .current
        .lock()
        .map(|s| s.download_dir.clone())
        .unwrap_or_default();
    let opts = serde_json::json!({ "dir": dir });
    let out = aria2::aria2_request(
        port,
        &secret,
        "aria2.addTorrent",
        serde_json::json!([b64, [], opts]),
    )?;
    out.get("result")
        .and_then(|r| r.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "aria2 did not return a gid".into())
}

fn format_speed(bps: u64) -> String {
    if bps == 0 {
        return "—".into();
    }
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let n = bps as f64;
    if n >= MB {
        format!("{:.1} MB/s", n / MB)
    } else if n >= KB {
        format!("{:.0} KB/s", n / KB)
    } else {
        format!("{bps} B/s")
    }
}
