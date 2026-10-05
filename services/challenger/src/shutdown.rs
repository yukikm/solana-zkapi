//! Latched process stop requests. Cancellation is used only at read-only await
//! points or by the bridge supervisor, which kills and reaps its owned child.
use crate::{Error, Result};
use std::future::Future;
use tokio::sync::watch;

#[derive(Clone)]
pub(crate) struct Shutdown(watch::Receiver<bool>);
pub(crate) struct Signals {
    pub shutdown: Shutdown,
    listener: tokio::task::JoinHandle<()>,
}
impl Signals {
    pub fn install() -> Result<Self> {
        let (sender, receiver) = watch::channel(false);
        #[cfg(unix)]
        let listener = {
            use tokio::signal::unix::{signal, SignalKind};
            // Register both before startup/replay or the first network request.
            let mut interrupt = signal(SignalKind::interrupt())?;
            let mut terminate = signal(SignalKind::terminate())?;
            tokio::spawn(async move {
                tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
                let _ = sender.send(true);
            })
        };
        #[cfg(not(unix))]
        let listener = tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            let _ = sender.send(true);
        });
        Ok(Self {
            shutdown: Shutdown(receiver),
            listener,
        })
    }
}
impl Drop for Signals {
    fn drop(&mut self) {
        self.listener.abort();
    }
}
impl Shutdown {
    pub fn checkpoint(&self) -> Result<()> {
        if *self.0.borrow() {
            Err(Error::Interrupted)
        } else {
            Ok(())
        }
    }
    async fn cancelled(&self) {
        let mut receiver = self.0.clone();
        loop {
            if *receiver.borrow_and_update() {
                return;
            }
            if receiver.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }
}
pub(crate) async fn interruptible<T>(
    shutdown: Option<&Shutdown>,
    work: impl Future<Output = T>,
) -> Result<T> {
    match shutdown {
        Some(shutdown) => tokio::select! {
            biased;
            _ = shutdown.cancelled() => Err(Error::Interrupted),
            value = work => Ok(value),
        },
        None => Ok(work.await),
    }
}
