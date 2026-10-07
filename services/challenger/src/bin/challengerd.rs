//! Native emergency CLI and daemon use the same journal/recovery implementation.
#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3
        || ![
            "init",
            "scan",
            "prove",
            "once",
            "run",
            "recover",
            "cleanup",
            "status",
            "migrate-archive",
            "archive-indexer",
        ]
        .contains(&args[1].as_str())
    {
        eprintln!(
            "usage: challengerd <init|scan|prove|once|run|recover|cleanup|status|migrate-archive|archive-indexer> CONFIG.json"
        );
        std::process::exit(2);
    }
    let result = if args[1] == "archive-indexer" {
        zkapi_challenger::archive_indexer::run(std::path::Path::new(&args[2])).await
    } else {
        match zkapi_challenger::runtime::read_config(std::path::Path::new(&args[2])) {
            Ok(config) => zkapi_challenger::runtime::run(config, &args[1]).await,
            Err(e) => Err(e),
        }
    };
    if result.is_err() {
        eprintln!("challenger stopped: configuration, evidence or recovery unavailable");
        std::process::exit(1);
    }
}
