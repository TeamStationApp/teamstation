// Node-API linking, for the `node` feature only: the addon resolves Node's
// symbols when Node loads it, not when it is linked.
fn main() {
    if std::env::var_os("CARGO_FEATURE_NODE").is_some() {
        napi_build::setup();
    }
}
