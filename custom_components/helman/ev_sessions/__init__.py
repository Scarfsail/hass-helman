"""The EV charging ledger: durable charging segments, their energy and attribution, and the 30-day view (#428).

``ledger`` holds the records and the pure rules that make them, ``store`` the
versioned store they live in, ``summary`` the figures the EV detail reads and
``service`` the runtime that follows the run mode and the recorder.
"""
