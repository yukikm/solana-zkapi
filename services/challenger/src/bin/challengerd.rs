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
            "project-history",
        ]
        .contains(&args[1].as_str())
    {
        eprintln!(
            "usage: challengerd <init|scan|prove|once|run|recover|cleanup|status|migrate-archive|archive-indexer|project-history> CONFIG.json"
        );
        std::process::exit(2);
    }
    let result = if args[1] == "project-history" {
        zkapi_challenger::projection_archive::run(std::path::Path::new(&args[2])).map(|report| {
            println!(
                "{}",
                serde_json::to_string(&report).expect("projection report")
            );
        })
    } else if args[1] == "archive-indexer" {
        zkapi_challenger::archive_indexer::run(std::path::Path::new(&args[2])).await
    } else if args[1] == "migrate-archive" {
        // Explicit offline legacy utility; normal daemon commands accept only v2.
        match zkapi_challenger::runtime::read_config(std::path::Path::new(&args[2])) {
            Ok(config) => zkapi_challenger::runtime::run(config, &args[1]).await,
            Err(e) => Err(e),
        }
    } else {
        match zkapi_challenger::runtime::read_current_config(std::path::Path::new(&args[2])) {
            Ok(config) => zkapi_challenger::runtime::run_current(config, &args[1]).await,
            Err(e) => Err(e),
        }
    };
    if let Err(error) = result {
        if args[1] == "project-history" {
            // Offline errors contain fixed reason strings, not source contents
            // or credentials. In particular, capacity preflight is actionable.
            eprintln!("offline history projection stopped: {error}");
        } else {
            eprintln!("challenger stopped: configuration, evidence or recovery unavailable");
        }
        std::process::exit(1);
    }
}
