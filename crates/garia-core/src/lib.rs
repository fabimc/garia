//! Shared domain logic for Garia (aria2, settings, catch, ftp, video, …).
//! No Tauri types — the shell crates call into this.

pub mod aria2;
pub mod catch;
pub mod ftp;
pub mod logins;
pub mod process;
pub mod schedule;
pub mod settings;
pub mod trash;
pub mod video;

pub use aria2::{Aria2, RPC_CONCURRENCY};
pub use settings::{
    DoneAction, LoginsState, RemoteInfo, Settings, SettingsState, TrafficMode, DEFAULT_RPC_PORT,
};
pub use video::{Probe, PreviewState, SidecarTool, Video, VideoTools};

#[cfg(test)]
mod tests {
    use crate::aria2::*;
    use crate::process::*;
    use crate::settings::*;
    use crate::video::*;
    use std::fs;
    use std::path::Path;
    use std::time::Duration;

    #[test]
    fn rpc_args_put_the_token_first() {
        let args = rpc_args("aria2.tellActive", serde_json::json!([["gid"]]), "s");
        assert_eq!(
            serde_json::json!(args),
            serde_json::json!(["token:s", ["gid"]])
        );
    }

    #[test]
    fn rpc_args_put_the_token_in_each_call_of_a_batch() {
        let batch = serde_json::json!([[
            { "methodName": "aria2.getGlobalStat" },
            { "methodName": "aria2.tellStatus", "params": ["2089b05ecca3d829", ["files"]] },
        ]]);
        let args = rpc_args("system.multicall", batch, "s");
        assert_eq!(
            serde_json::json!(args),
            serde_json::json!([[
                { "methodName": "aria2.getGlobalStat", "params": ["token:s"] },
                {
                    "methodName": "aria2.tellStatus",
                    "params": ["token:s", "2089b05ecca3d829", ["files"]],
                },
            ]])
        );
    }

    #[test]
    fn ffmpeg_duration_lines_become_microseconds() {
        let line = "  Duration: 00:03:21.45, start: 0.000000, bitrate: 128 kb/s";
        assert_eq!(ffmpeg_duration_us(line), Some(201_450_000));
        assert_eq!(ffmpeg_duration_us("  Duration: N/A, start: 0.0"), None);
        assert_eq!(ffmpeg_duration_us("Stream #0:0: Video: h264"), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_cancelled_probe_stops_and_other_runs_do_not() {
        let sleep = || vec!["2".to_string()];
        let steady = std::thread::spawn(move || run_watched("sleep", &sleep(), 10, &[], false));
        let t = std::time::Instant::now();
        let probe = std::thread::spawn(move || run_watched("sleep", &sleep(), 30, &[], true));
        std::thread::sleep(Duration::from_millis(300));
        cancel_video_probes();

        let out = probe.join().unwrap().unwrap();
        assert!(!out.status.success(), "the probe was killed");
        assert!(t.elapsed() < Duration::from_millis(1500), "and promptly");
        let out = steady.join().unwrap().unwrap();
        assert!(out.status.success(), "a run that cannot be cancelled finishes");
    }

    #[test]
    fn batch_adds_spots_an_add_in_a_batch() {
        let reads = serde_json::json!([[{ "methodName": "aria2.tellActive", "params": [] }]]);
        let adds = serde_json::json!([[{ "methodName": "aria2.addUri", "params": [["u"]] }]]);
        assert!(!batch_adds(&reads));
        assert!(batch_adds(&adds));
    }

    /// Real yt-dlp output, trimmed to the fields the parser reads. YouTube
    /// because it is the hard case — 53 formats, not one of which is a
    /// complete file — and Wikimedia because it is the easy one.
    const YOUTUBE: &str = include_str!("../tests/fixtures/youtube.json");
    const COMMONS: &str = include_str!("../tests/fixtures/commons.json");

    fn parse(fixture: &str) -> VideoInfo {
        trim_info(&serde_json::from_str(fixture).unwrap()).unwrap()
    }

    fn settings_from(json: &str) -> Settings {
        serde_json::from_str::<Settings>(json).unwrap().normalised()
    }

    #[test]
    fn torrent_bytes_are_what_aria2_expects() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"Man"), "TWFu");
        assert_eq!(encode_base64(b"Ma"), "TWE=");
        assert_eq!(encode_base64(b"M"), "TQ==");
    }

    /// The upgrade case: a settings file written before the modes existed
    /// carries a cap and no mode. Losing it would silently un-throttle a
    /// connection someone deliberately throttled.
    #[test]
    fn an_old_cap_becomes_medium() {
        let s = settings_from(r#"{"downloadDir":"/tmp","maxOverallDownloadLimit":786432}"#);
        assert_eq!(s.traffic_mode, Some(TrafficMode::Medium));
        assert_eq!(s.medium_limit, 786_432);
        assert_eq!(s.max_overall_download_limit, 786_432);
    }

    #[test]
    fn an_old_file_with_no_cap_is_full_speed() {
        let s = settings_from(r#"{"downloadDir":"/tmp"}"#);
        assert_eq!(s.traffic_mode, Some(TrafficMode::Full));
        assert_eq!(s.max_overall_download_limit, 0);
        // The modes still mean something the moment one is picked.
        assert_eq!(s.medium_limit, DEFAULT_MEDIUM_LIMIT);
        assert_eq!(s.light_limit, DEFAULT_LIGHT_LIMIT);
    }

    /// An upgrade must not reopen the welcome sheet. Missing means seen.
    #[test]
    fn an_old_file_has_already_seen_setup() {
        let s = settings_from(r#"{"downloadDir":"/tmp"}"#);
        assert!(s.setup_seen);
    }

    #[test]
    fn a_fresh_install_has_not_seen_setup() {
        assert!(!Settings::default().setup_seen);
    }

    /// The overall cap is derived, never taken: the frontend sends the whole
    /// settings object back and must not be able to contradict the mode.
    #[test]
    fn the_mode_decides_the_cap() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","trafficMode":"light","lightLimit":262144,
                "maxOverallDownloadLimit":99999999}"#,
        );
        assert_eq!(s.max_overall_download_limit, 262_144);

        let s =
            settings_from(r#"{"downloadDir":"/tmp","trafficMode":"full","mediumLimit":262144}"#);
        assert_eq!(s.max_overall_download_limit, 0);
    }

    /// A window has to have a width. Read as "always" a zero-length one is the
    /// setting being off; read as "never" it is a download manager that never
    /// downloads — so it is stored as off rather than as either reading.
    #[test]
    fn a_window_with_no_width_is_not_stored_as_a_window() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","scheduleEnabled":true,
                "scheduleStart":480,"scheduleEnd":480}"#,
        );
        assert!(!s.schedule_enabled);

        let s = settings_from(
            r#"{"downloadDir":"/tmp","scheduleEnabled":true,
                "scheduleStart":1320,"scheduleEnd":360}"#,
        );
        assert!(s.schedule_enabled);
        // An overnight window is stored exactly as typed; wrapping midnight is
        // the reader's job, not the writer's.
        assert_eq!((s.schedule_start, s.schedule_end), (1320, 360));
    }

    /// Minutes past the end of a day come from a hand-edited file, and a
    /// window nobody can reach is worse than one that has moved.
    #[test]
    fn a_time_of_day_past_midnight_wraps_into_one() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","scheduleEnabled":true,
                "scheduleStart":1500,"scheduleEnd":480}"#,
        );
        assert_eq!(s.schedule_start, 60);
    }

    #[test]
    fn a_file_that_never_heard_of_the_queue_leaves_it_running() {
        let s = settings_from(r#"{"downloadDir":"/tmp"}"#);
        assert!(!s.queue_stopped);
        assert_eq!(s.done_action, DoneAction::None);
    }

    #[test]
    fn stop_queue_and_a_done_action_round_trip() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","queueStopped":true,"doneAction":"sleep"}"#,
        );
        assert!(s.queue_stopped);
        assert_eq!(s.done_action, DoneAction::Sleep);

        let s = settings_from(r#"{"downloadDir":"/tmp","doneAction":"shutdown"}"#);
        assert_eq!(s.done_action, DoneAction::Shutdown);
    }

    /// The switch without a list is the four kinds it has always meant.
    #[test]
    fn smart_folders_seed_the_four_kinds() {
        let s = settings_from(r#"{"downloadDir":"/tmp","smartFolders":true}"#);
        assert_eq!(s.categories.len(), 4);
        assert!(s.categories.iter().any(|c| c.id == "video"));
        assert!(s.categories.iter().any(|c| c.folder == "Archives"));
    }

    #[test]
    fn an_edited_category_list_is_kept() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","smartFolders":true,
                "categories":[{"id":"iso","name":"ISOs","extensions":[".ISO","iso"],"folder":"Images"}]}"#,
        );
        assert_eq!(s.categories.len(), 1);
        assert_eq!(s.categories[0].folder, "Images");
        assert_eq!(s.categories[0].extensions, vec!["iso"]);
    }

    #[test]
    fn a_dotdot_folder_falls_back_to_the_name() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","smartFolders":true,
                "categories":[{"name":"Safe","folder":"../elsewhere","host":"https://FILES.Example.com/a"}]}"#,
        );
        assert_eq!(s.categories[0].folder, "Safe");
        assert_eq!(s.categories[0].host, "files.example.com");
        assert_eq!(s.categories[0].id, "safe");
    }

    /// A blank field is "unset", and anything under a kilobyte a second is a
    /// stall rather than a limit.
    #[test]
    fn a_mode_never_means_stopped() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","trafficMode":"medium","mediumLimit":0,"lightLimit":12}"#,
        );
        assert_eq!(s.medium_limit, DEFAULT_MEDIUM_LIMIT);
        assert_eq!(s.light_limit, MIN_LIMIT);
        assert_eq!(s.max_overall_download_limit, DEFAULT_MEDIUM_LIMIT);
    }

    /// `--seed-time=0` means "never seed", so "no time limit" has to be the
    /// absence of the option rather than a zero.
    #[test]
    fn no_seed_time_means_no_seed_time_option() {
        let settings = settings_from(r#"{"downloadDir":"/tmp","seedTimeMinutes":0}"#);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), Path::new("/tmp/no-netrc"), &settings);
        assert!(!args.iter().any(|a| a.starts_with("--seed-time")));
        assert!(args.iter().any(|a| a == "--seed-ratio=1"));

        let settings = settings_from(r#"{"downloadDir":"/tmp","seedTimeMinutes":90}"#);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), Path::new("/tmp/no-netrc"), &settings);
        assert!(args.iter().any(|a| a == "--seed-time=90"));
    }

    /// The one flag that decides whether the RPC port is this machine's or the
    /// network's. It is always written out, off as well as on: aria2's own
    /// default is false, but a line that says so is a line nobody has to go
    /// and check.
    #[test]
    fn the_socket_is_loopback_unless_remote_control_says_otherwise() {
        let off = settings_from(r#"{"downloadDir":"/tmp"}"#);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), Path::new("/tmp/no-netrc"), &off);
        assert!(args.iter().any(|a| a == "--rpc-listen-all=false"));

        let on = settings_from(r#"{"downloadDir":"/tmp","remoteControl":true}"#);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), Path::new("/tmp/no-netrc"), &on);
        assert!(args.iter().any(|a| a == "--rpc-listen-all=true"));
    }

    /// A settings file from before remote control existed must not read as a
    /// machine that has opted into it.
    #[test]
    fn a_settings_file_without_the_field_keeps_the_port_closed() {
        let s = settings_from(r#"{"downloadDir":"/tmp","catchClipboard":true}"#);
        assert!(!s.remote_control);
    }

    /// A settings file from before the confirm sheet existed still asks —
    /// the extension is new, and a silent add would be the surprising one.
    #[test]
    fn a_settings_file_without_confirm_capture_still_asks() {
        let s = settings_from(r#"{"downloadDir":"/tmp"}"#);
        assert!(s.confirm_capture);
    }

    /// A settings file from before the proxy field existed must not start
    /// sending traffic through a host nobody named.
    #[test]
    fn a_settings_file_without_proxy_leaves_it_off() {
        let s = settings_from(r#"{"downloadDir":"/tmp"}"#);
        assert!(!s.proxy_enabled);
        assert_eq!(s.proxy_port, 8080);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), Path::new("/tmp/no-netrc"), &s);
        assert!(!args.iter().any(|a| a.starts_with("--all-proxy")));
    }

    #[test]
    fn an_enabled_proxy_is_an_all_proxy_flag() {
        let mut s = settings_from(
            r#"{"downloadDir":"/tmp","proxyEnabled":true,"proxyHost":"proxy.example.com","proxyPort":3128,"proxyUser":"sam"}"#,
        );
        s.proxy_password = "s3cret".into();
        s.proxy_no_proxy = "localhost,127.0.0.1".into();
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), Path::new("/tmp/no-netrc"), &s);
        assert!(args.iter().any(|a| a == "--all-proxy=http://proxy.example.com:3128"));
        assert!(args.iter().any(|a| a == "--all-proxy-user=sam"));
        assert!(args.iter().any(|a| a == "--all-proxy-passwd=s3cret"));
        assert!(args.iter().any(|a| a == "--no-proxy=localhost,127.0.0.1"));
    }

    #[test]
    fn a_pasted_proxy_url_fills_host_and_port() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","proxyEnabled":true,"proxyHost":"http://user:secret@PROXY.Example.com:3128"}"#,
        );
        assert_eq!(s.proxy_host, "proxy.example.com");
        assert_eq!(s.proxy_port, 3128);
        assert!(s.proxy_user.is_empty());
    }

    #[test]
    fn an_empty_host_turns_the_proxy_off() {
        let s = settings_from(r#"{"downloadDir":"/tmp","proxyEnabled":true,"proxyHost":"  "}"#);
        assert!(!s.proxy_enabled);
    }

    #[test]
    fn the_proxy_password_is_not_in_settings_json() {
        let mut s = settings_from(
            r#"{"downloadDir":"/tmp","proxyEnabled":true,"proxyHost":"proxy.example.com"}"#,
        );
        s.proxy_password = "s3cret".into();
        s.has_proxy_password = true;
        let json = serde_json::to_string(&s.for_disk()).unwrap();
        assert!(!json.contains("s3cret"));
        assert!(!json.contains("proxyPassword"));
        let front = serde_json::to_value(s.for_frontend()).unwrap();
        assert_eq!(front["hasProxyPassword"], true);
        assert!(front.get("proxyPassword").is_none());
    }

    #[test]
    fn ytdlp_proxy_encodes_the_login() {
        let mut s = settings_from(
            r#"{"downloadDir":"/tmp","proxyEnabled":true,"proxyHost":"proxy.example.com","proxyPort":3128}"#,
        );
        s.proxy_user = "a@b".into();
        s.proxy_password = "p@ss:word".into();
        assert_eq!(
            ytdlp_proxy_url(&s).as_deref(),
            Some("http://a%40b:p%40ss%3Aword@proxy.example.com:3128")
        );
    }

    #[test]
    fn no_proxy_list_is_deduped() {
        let s = settings_from(
            r#"{"downloadDir":"/tmp","proxyNoProxy":"localhost, 127.0.0.1 localhost"}"#,
        );
        assert_eq!(s.proxy_no_proxy, "localhost,127.0.0.1");
    }

    /// The token survives a relaunch — a pairing that had to be redone every
    /// morning is not a pairing — and anything that isn't one is replaced
    /// rather than handed to aria2, which would take it and leave every
    /// paired device quietly locked out.
    #[test]
    fn the_remote_token_persists_but_only_while_it_is_a_token() {
        let dir = std::env::temp_dir().join("garia-remote-test");
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("remote-secret");
        let _ = fs::remove_file(&file);

        let first = remote_secret(&file);
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(remote_secret(&file), first, "a second launch re-pairs nothing");

        fs::write(&file, "not a token").unwrap();
        assert_ne!(remote_secret(&file), "not a token");
        assert_eq!(remote_secret(&file).len(), 32);

        // 0600, the way the logins file is: a token every account on the
        // machine can read is not one.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        let _ = fs::remove_file(&file);
    }

    /// Asking the routing table for the source address it would use, rather
    /// than walking the interface list. The assertion has to hold on a laptop
    /// with no network too, which is the case the panel has its own sentence
    /// for: no address is an answer, a loopback one would be a wrong answer.
    #[test]
    fn the_address_offered_is_one_another_device_could_reach() {
        match local_ip() {
            None => {}
            Some(ip) => {
                let parsed: std::net::IpAddr = ip.parse().expect("not an address");
                assert!(!parsed.is_loopback());
                assert!(!parsed.is_unspecified());
            }
        }
    }

    /// The pairing QR carries the secret and nothing else, so it is always the
    /// same 32 characters and therefore always the same size: 29 modules a
    /// side, which is version 3 at error-correction level M. Version 2 stops
    /// at 26 bytes of the byte mode a lowercase hex token has to use.
    #[test]
    fn the_pairing_qr_is_a_square_of_modules() {
        let (width, modules) = qr_of(&random_secret());
        assert_eq!(width, 29);
        assert_eq!(modules.len(), width * width);
        // A finder pattern sits in each of three corners, so the top-left
        // module is dark in every QR ever made.
        assert!(modules[0]);
    }

    /// Both credentials aria2 will only take at launch. The netrc is named
    /// only when there is one — otherwise garia would be quietly overriding
    /// the user's own ~/.netrc with a file that isn't there.
    #[test]
    fn credentials_are_named_only_when_they_exist() {
        let dir = std::env::temp_dir().join("garia-netrc-test");
        let _ = fs::create_dir_all(&dir);
        let netrc = dir.join("netrc");
        let _ = fs::remove_file(&netrc);

        let settings = settings_from(r#"{"downloadDir":"/tmp"}"#);
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), &netrc, &settings);
        assert!(!args.iter().any(|a| a.starts_with("--netrc-path")));
        assert!(!args.iter().any(|a| a.starts_with("--load-cookies")));

        fs::write(&netrc, "machine example.com\n").unwrap();
        let jar = dir.join("cookies.txt");
        fs::write(&jar, "# Netscape HTTP Cookie File\n").unwrap();
        let settings = settings_from(&format!(
            r#"{{"downloadDir":"/tmp","cookieFile":"{}"}}"#,
            jar.display()
        ));
        let args = aria2_args(6800, "s", Path::new("/tmp/s.txt"), &netrc, &settings);
        assert!(args
            .iter()
            .any(|a| a == &format!("--netrc-path={}", netrc.display())));
        assert!(args
            .iter()
            .any(|a| a == &format!("--load-cookies={}", jar.display())));

        // A jar that has been moved or deleted is no jar at all.
        let settings = settings_from(r#"{"downloadDir":"/tmp","cookieFile":"/nope/gone.txt"}"#);
        assert_eq!(settings.cookie_file, "");
    }

    #[test]
    fn a_hand_edited_ratio_stays_a_ratio() {
        assert_eq!(
            settings_from(r#"{"downloadDir":"/tmp","seedRatio":-4}"#).seed_ratio,
            1.0
        );
        assert_eq!(
            settings_from(r#"{"downloadDir":"/tmp","seedRatio":1e9}"#).seed_ratio,
            100.0
        );
        // 0.0 is meaningful: seed until told to stop.
        assert_eq!(
            settings_from(r#"{"downloadDir":"/tmp","seedRatio":0}"#).seed_ratio,
            0.0
        );
    }

    #[test]
    fn keeps_only_what_aria2_can_fetch() {
        let info = parse(YOUTUBE);
        // Not one HLS or DASH playlist survives: handing aria2 an m3u8 URL
        // downloads the playlist, not the video.
        assert!(!info.formats.is_empty());
        for f in &info.formats {
            assert!(!f.url.is_empty(), "a format with no URL got through");
        }
        // 32 of YouTube's 53 formats are plain HTTPS; the rest are segmented.
        assert_eq!(info.formats.len(), 32);
    }

    #[test]
    fn youtube_has_no_complete_formats() {
        let info = parse(YOUTUBE);
        // The whole reason merging exists. If this ever fails, YouTube started
        // serving single-file formats again and the picker gets simpler.
        assert!(info.formats.iter().all(|f| f.kind != "complete"));
        assert!(info.formats.iter().any(|f| f.kind == "video"));
        assert!(info.formats.iter().any(|f| f.kind == "audio"));
        assert_eq!(info.title, "Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film");
        assert_eq!(info.uploader, "Blender");
    }

    #[test]
    fn tallest_picture_first() {
        let info = parse(YOUTUBE);
        let heights: Vec<u64> = info.formats.iter().map(|f| f.height).collect();
        assert!(heights.windows(2).all(|w| w[0] >= w[1]), "{heights:?}");
        assert_eq!(heights[0], 2160);
    }

    #[test]
    fn a_missing_codec_field_is_not_a_missing_stream() {
        let info = parse(COMMONS);
        // Two of Wikimedia's four formats name no codecs at all. Reading that
        // as "no audio" would drop the only formats the page offers.
        assert_eq!(info.formats.len(), 4);
        assert!(info.formats.iter().all(|f| f.kind == "complete"));
    }

    #[test]
    fn headers_come_out_ready_for_aria2() {
        let info = parse(YOUTUBE);
        let headers = &info.formats[0].headers;
        assert!(!headers.is_empty());
        // aria2's `header` option takes "Name: Value" lines, not an object.
        assert!(headers.iter().all(|h| h.contains(": ")));
        assert!(headers.iter().any(|h| h.starts_with("User-Agent: ")));
    }

    #[test]
    fn sizes_fall_back_to_the_estimate() {
        let info = parse(YOUTUBE);
        assert!(
            info.formats.iter().all(|f| f.filesize > 0),
            "a format came through with no size at all"
        );
    }

    fn playlist_of(entries: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "_type": "playlist",
            "title": "Physics lectures",
            "channel": "Physicsworks",
            "webpage_url": "https://example.com/list",
            "extractor_key": "Example",
            "entries": entries,
        })
    }

    fn as_playlist(root: &serde_json::Value) -> PlaylistInfo {
        match trim_probe(root).unwrap() {
            Probe::Playlist(list) => list,
            Probe::Video(v) => panic!("a playlist came back as the video {:?}", v.title),
        }
    }

    /// The whole point of the change: a playlist URL used to answer with its
    /// first video, which is a wrong answer rather than a missing feature.
    #[test]
    fn a_playlist_page_is_a_list_not_its_first_video() {
        let root = playlist_of(serde_json::json!([
            { "id": "a", "title": "One",   "url": "https://example.com/a", "duration": 61 },
            { "id": "b", "title": "Two",   "url": "https://example.com/b" },
            { "id": "c", "title": "Three", "url": "https://example.com/c" },
        ]));
        let list = as_playlist(&root);
        assert_eq!(list.total, 3);
        // The order is the playlist's, because that is the order they queue in.
        assert_eq!(
            list.entries.iter().map(|e| e.title.as_str()).collect::<Vec<_>>(),
            ["One", "Two", "Three"]
        );
        assert_eq!(list.entries[0].url, "https://example.com/a");
        assert_eq!(list.entries[0].duration, 61.0);
        // `channel` where another site would have said `uploader`.
        assert_eq!(list.uploader, "Physicsworks");
    }

    /// `--no-playlist` still wins for a watch link that carries a list, so the
    /// single-video path has to survive the flat listing being asked for.
    #[test]
    fn a_single_video_is_still_a_video() {
        let root: serde_json::Value = serde_json::from_str(COMMONS).unwrap();
        match trim_probe(&root).unwrap() {
            Probe::Video(v) => {
                assert_eq!(v.title, "Physicsworks");
                assert_eq!(v.formats.len(), 4);
            }
            Probe::Playlist(_) => panic!("a video came back as a playlist"),
        }
    }

    #[test]
    fn an_empty_playlist_is_an_error_not_an_empty_picker() {
        let root = playlist_of(serde_json::json!([]));
        assert!(trim_probe(&root).is_err());
    }

    /// A channel's front page lists its tabs, which are playlists. Ticking one
    /// would download nothing, so it says which page to paste instead.
    #[test]
    fn a_page_of_playlists_says_so() {
        let root = playlist_of(serde_json::json!([
            { "_type": "playlist", "id": "videos", "title": "Videos", "url": "https://example.com/v" },
            { "_type": "playlist", "id": "shorts", "title": "Shorts", "url": "https://example.com/s" },
        ]));
        let err = trim_probe(&root).unwrap_err();
        assert!(err.contains("lists playlists"), "unhelpful: {err}");
    }

    /// An entry with nowhere to go can't be probed and can't be queued.
    #[test]
    fn an_entry_with_no_url_is_dropped() {
        let root = playlist_of(serde_json::json!([
            { "id": "a", "title": "One" },
            { "id": "b", "title": "Two", "webpage_url": "https://example.com/b" },
        ]));
        let list = as_playlist(&root);
        assert_eq!(list.entries.len(), 1);
        assert_eq!(list.entries[0].url, "https://example.com/b");
    }

    /// A channel holds more than a dialog can show. The cap is a cap, and the
    /// count it came from is kept so the picker can say what it left behind.
    #[test]
    fn a_long_channel_is_capped_and_says_so() {
        let entries: Vec<serde_json::Value> = (0..MAX_PLAYLIST_ENTRIES + 120)
            .map(|i| serde_json::json!({ "id": i.to_string(), "url": format!("https://example.com/{i}") }))
            .collect();
        let mut root = playlist_of(serde_json::Value::Array(entries));
        root["playlist_count"] = serde_json::json!(1240);
        let list = as_playlist(&root);
        assert_eq!(list.entries.len(), MAX_PLAYLIST_ENTRIES);
        assert_eq!(list.total, 1240);
    }

    /// A count the site got wrong must not read as "there are more" — the
    /// picker would promise entries nothing can produce.
    #[test]
    fn a_count_smaller_than_the_listing_is_not_a_count() {
        let mut root = playlist_of(serde_json::json!([
            { "id": "a", "url": "https://example.com/a" },
            { "id": "b", "url": "https://example.com/b" },
        ]));
        root["playlist_count"] = serde_json::json!(1);
        assert_eq!(as_playlist(&root).total, 2);
    }

    /// Flat entries carry a `thumbnails` list and no `thumbnail`, worst first
    /// — which is the end worth taking for a 96-pixel row.
    #[test]
    fn a_flat_entry_takes_its_smallest_thumbnail() {
        let root = playlist_of(serde_json::json!([{
            "id": "a",
            "url": "https://example.com/a",
            "thumbnails": [
                { "url": "https://example.com/small.jpg", "height": 90 },
                { "url": "https://example.com/huge.jpg",  "height": 1080 },
            ],
        }]));
        assert_eq!(as_playlist(&root).entries[0].thumbnail, "https://example.com/small.jpg");
    }

    /// One top-level ISO box: a big-endian size covering the header, the
    /// four-character type, and however much filler the size claims.
    fn boxed(kind: &[u8; 4], payload: usize) -> Vec<u8> {
        let size = (8 + payload) as u32;
        let mut out = size.to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend(std::iter::repeat_n(0u8, payload));
        out
    }

    fn walk(file: &[u8], ready: u64) -> bool {
        moov_within(&mut std::io::Cursor::new(file.to_vec()), ready)
    }

    /// A faststart MP4 — the one `mux_video` writes — puts the index in front
    /// of the media, which is the whole reason preview works on one at all.
    #[test]
    fn a_faststart_mp4_is_playable_from_its_first_bytes() {
        let mut file = boxed(b"ftyp", 24);
        file.extend(boxed(b"moov", 900));
        file.extend(boxed(b"mdat", 40_000));
        assert!(walk(&file, 2_000));
    }

    /// The case the panel exists to explain: everything has arrived except the
    /// index, because the index is behind all of it.
    #[test]
    fn an_index_at_the_end_is_not_playable_until_it_arrives() {
        let mut file = boxed(b"ftyp", 24);
        file.extend(boxed(b"mdat", 40_000));
        file.extend(boxed(b"moov", 900));
        assert!(!walk(&file, 20_000), "half the media is not an index");
        assert!(walk(&file, file.len() as u64), "and the whole file is");
    }

    /// Starting inside the downloaded prefix is not enough — a player reads
    /// the whole index, and the rest of it is still a hole.
    #[test]
    fn an_index_that_runs_past_the_frontier_is_not_playable() {
        let mut file = boxed(b"ftyp", 24);
        file.extend(boxed(b"moov", 4_000));
        assert!(!walk(&file, 1_000));
        assert!(walk(&file, 4_100));
    }

    /// A box header read past the frontier is a header read off a hole, which
    /// aria2 preallocated as zeroes — and a zero size means "to end of file".
    /// Walking that would report an index the file may not have.
    #[test]
    fn a_header_on_an_unwritten_hole_is_not_walked() {
        let mut file = boxed(b"ftyp", 24);
        file.extend(vec![0u8; 4_000]);
        assert!(!walk(&file, file.len() as u64));
    }

    /// The 64-bit escape, which is how any mdat over 4 GB is written — and a
    /// preview is exactly the case where the file is that big.
    #[test]
    fn a_64_bit_mdat_is_stepped_over_to_reach_the_index() {
        let mut file = boxed(b"ftyp", 24);
        let payload = 5_000u64;
        file.extend(1u32.to_be_bytes());
        file.extend(b"mdat");
        file.extend((16 + payload).to_be_bytes());
        file.extend(vec![0u8; payload as usize]);
        file.extend(boxed(b"moov", 100));
        assert!(walk(&file, file.len() as u64));
    }

    /// The sidecar is looked at first — a bundled garia must merge without
    /// anything installed — and only it is labelled "bundled", because that
    /// label is what Settings prints and what a support answer starts from.
    #[test]
    fn the_bundled_ffmpeg_is_looked_at_first_and_is_the_only_bundled_one() {
        let candidates = ffmpeg_candidates();
        let exe_dir = std::env::current_exe().unwrap();
        let exe_dir = exe_dir.parent().unwrap();

        assert_eq!(candidates[0].1, "bundled");
        assert_eq!(candidates[0].0, exe_dir.join("ffmpeg").display().to_string());
        assert!(candidates[1..].iter().all(|(_, origin)| *origin == "system"));
    }

}
