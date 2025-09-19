# Monero LWS Load Balancer wrapper

Provides wrapper on top of Monero LWS for the following functionality

- Load balances across multiple LWS instances
- Automatically enables and disables scanning of addresses based
on how recent the address is used
- Holds address info in a Couch database for faster lookup
- Provides a web interface to look up address status and triggering a rescan
