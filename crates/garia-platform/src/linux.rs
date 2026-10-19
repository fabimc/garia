//! Linux-specific wiring.

use crate::Platform;

pub fn on_start(_platform: &Platform) {
    // Deep-link / .desktop registration belongs to packaging (Phase 4).
    // Runtime open is handled via argv in Platform::start.
}

pub fn set_badge(_count: u32) {
    // No dock badge on Linux.
}
