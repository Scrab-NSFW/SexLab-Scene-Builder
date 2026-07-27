//! UI job progress events (`on_job_progress`) for long import/export work.

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize)]
pub struct JobProgressPayload {
    pub job: String,
    pub title: String,
    pub message: String,
    pub current: Option<u64>,
    pub total: Option<u64>,
    pub done: bool,
    pub error: Option<String>,
}

/// Emits progress to the frontend when an `AppHandle` is available (no-op in CLI/tests).
pub struct JobProgress<'a> {
    app: Option<&'a AppHandle>,
    job: String,
    title: String,
}

impl<'a> JobProgress<'a> {
    pub fn new(app: Option<&'a AppHandle>, job: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            app,
            job: job.into(),
            title: title.into(),
        }
    }

    pub fn start(&self, message: &str) {
        self.emit(JobProgressPayload {
            job: self.job.clone(),
            title: self.title.clone(),
            message: message.to_string(),
            current: None,
            total: None,
            done: false,
            error: None,
        });
    }

    pub fn update(&self, message: &str, current: Option<u64>, total: Option<u64>) {
        self.emit(JobProgressPayload {
            job: self.job.clone(),
            title: self.title.clone(),
            message: message.to_string(),
            current,
            total,
            done: false,
            error: None,
        });
    }

    pub fn phase(&self, message: &str) {
        self.update(message, None, None);
    }

    pub fn done(&self) {
        self.emit(JobProgressPayload {
            job: self.job.clone(),
            title: self.title.clone(),
            message: "Done".into(),
            current: None,
            total: None,
            done: true,
            error: None,
        });
    }

    pub fn fail(&self, err: &str) {
        self.emit(JobProgressPayload {
            job: self.job.clone(),
            title: self.title.clone(),
            message: err.to_string(),
            current: None,
            total: None,
            done: true,
            error: Some(err.to_string()),
        });
    }

    fn emit(&self, payload: JobProgressPayload) {
        let Some(app) = self.app else {
            return;
        };
        if let Err(e) = app.emit("on_job_progress", &payload) {
            log::warn!("Failed to emit on_job_progress: {}", e);
        }
    }
}
