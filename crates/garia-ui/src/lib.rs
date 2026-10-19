//! iced shell for Garia — Phase 2 MVP (queue + RPC poll, tiny-skia).

use std::sync::Arc;
use std::time::Duration;

use garia_core::aria2::{self, Engine, QueueSnapshot};
use garia_core::settings::Settings;
use iced::widget::{button, column, container, row, scrollable, text, text_input, Space};
use iced::{Alignment, Element, Fill, Length, Subscription, Task, Theme};

/// Shared engine handle. Aria2 is process state; the UI holds it behind Arc.
#[derive(Clone)]
pub struct EngineHandle {
    pub inner: Arc<Engine>,
}

pub struct App {
    engine: EngineHandle,
    queue: QueueSnapshot,
    download_dir: String,
    status: String,
    saving: bool,
}

#[derive(Debug, Clone)]
pub enum Message {
    Tick,
    QueuePolled(QueueSnapshot),
    DownloadDirChanged(String),
    SaveSettings,
    SettingsSaved(Result<Settings, String>),
}

impl App {
    pub fn new(engine: Engine) -> (Self, Task<Message>) {
        let download_dir = engine
            .settings
            .current
            .lock()
            .map(|s| s.download_dir.clone())
            .unwrap_or_default();
        let handle = EngineHandle {
            inner: Arc::new(engine),
        };
        let app = Self {
            engine: handle.clone(),
            queue: QueueSnapshot::default(),
            download_dir,
            status: "Starting…".into(),
            saving: false,
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
            Message::QueuePolled(snap) => {
                if let Some(err) = &snap.error {
                    self.status = format!("aria2 unreachable — {err}");
                } else {
                    let n = snap.active + snap.waiting;
                    self.status = format!(
                        "{} active · {} waiting · {} stopped · {} shown",
                        snap.active,
                        snap.waiting,
                        snap.stopped,
                        snap.rows.len()
                    );
                    if n == 0 && snap.rows.is_empty() {
                        self.status.push_str(" · queue empty");
                    }
                }
                self.queue = snap;
                Task::none()
            }
            Message::DownloadDirChanged(dir) => {
                self.download_dir = dir;
                Task::none()
            }
            Message::SaveSettings => {
                self.saving = true;
                let engine = self.engine.clone();
                let dir = self.download_dir.clone();
                Task::perform(
                    async move {
                        tokio::task::spawn_blocking(move || save_download_dir(&engine, dir))
                            .await
                            .map_err(|e| e.to_string())?
                    },
                    Message::SettingsSaved,
                )
            }
            Message::SettingsSaved(result) => {
                self.saving = false;
                match result {
                    Ok(settings) => {
                        self.download_dir = settings.download_dir;
                        self.status = "Settings saved".into();
                    }
                    Err(e) => self.status = format!("Could not save settings: {e}"),
                }
                Task::none()
            }
        }
    }

    pub fn subscription(&self) -> Subscription<Message> {
        iced::time::every(Duration::from_secs(1)).map(|_| Message::Tick)
    }

    pub fn view(&self) -> Element<'_, Message> {
        let header = column![
            text("Garia").size(32),
            text(&self.status).size(14),
        ]
        .spacing(4);

        let save_btn = if self.saving {
            button("Saving…").padding([8, 14])
        } else {
            button("Save")
                .on_press(Message::SaveSettings)
                .padding([8, 14])
        };

        let settings = column![
            text("Download folder").size(16),
            row![
                text_input("/path/to/downloads", &self.download_dir)
                    .on_input(Message::DownloadDirChanged)
                    .padding(8)
                    .width(Fill),
                save_btn,
            ]
            .spacing(8)
            .align_y(Alignment::Center),
        ]
        .spacing(6);

        let queue_header = row![
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
            column(
                self.queue
                    .rows
                    .iter()
                    .map(|row| {
                        let progress = if row.total > 0 {
                            format!(
                                "{:.0}%",
                                (row.completed as f64 / row.total as f64) * 100.0
                            )
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
                    })
                    .collect::<Vec<_>>(),
            )
            .spacing(2)
            .into()
        };

        let body = column![
            header,
            Space::with_height(Length::Fixed(12.0)),
            settings,
            Space::with_height(Length::Fixed(16.0)),
            text("Queue").size(18),
            queue_header,
            scrollable(rows).height(Fill),
        ]
        .spacing(4)
        .padding(20);

        container(body).width(Fill).height(Fill).into()
    }

    pub fn theme(&self) -> Theme {
        Theme::Light
    }
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

fn save_download_dir(engine: &EngineHandle, dir: String) -> Result<Settings, String> {
    let mut settings = engine
        .inner
        .settings
        .current
        .lock()
        .map(|s| s.clone())
        .map_err(|_| "could not read settings".to_string())?;
    settings.download_dir = dir;
    let saved = aria2::save_settings(&engine.inner.aria2, &engine.inner.settings, settings)?;
    Ok(saved)
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
