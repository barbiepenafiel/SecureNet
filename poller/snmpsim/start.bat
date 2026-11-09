@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  NetWatch — Start snmpsim agents (Option 1)
REM
REM  Prerequisites:
REM    pip install snmpsim
REM
REM  Each device gets its own UDP port on 127.0.0.1.
REM  The poller (devices.js, POLL_MODE=sim) targets these ports.
REM
REM  Run this script first, then: cd .. && node poller.js
REM ─────────────────────────────────────────────────────────────────────────────

echo Starting snmpsim agents...

start "Core-FW-1  :1161" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1161 --data-dir=data\core-fw-1  --quiet
start "Core-SW-1  :1162" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1162 --data-dir=data\core-sw-1  --quiet
start "SW-A1      :1163" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1163 --data-dir=data\sw-a1      --quiet
start "SW-A2      :1164" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1164 --data-dir=data\sw-a2      --quiet
REM  SW-B2 is intentionally skipped (simulates DOWN device — poller gets no response)
start "SW-C1      :1165" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1165 --data-dir=data\sw-c1      --quiet
start "AP-A-01    :1166" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1166 --data-dir=data\ap-a-01    --quiet
start "AP-A-02    :1167" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1167 --data-dir=data\ap-a-02    --quiet
start "AP-A-03    :1168" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1168 --data-dir=data\ap-a-03    --quiet
start "AP-A-04    :1169" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1169 --data-dir=data\ap-a-04    --quiet
start "AP-C-01    :1170" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1170 --data-dir=data\ap-c-01    --quiet
start "AP-C-02    :1171" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1171 --data-dir=data\ap-c-02    --quiet
start "SRV-DC-01  :1172" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1172 --data-dir=data\srv-dc-01  --quiet
start "SRV-DC-02  :1173" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1173 --data-dir=data\srv-dc-02  --quiet
start "SRV-DC-03  :1174" /min python -m snmpsim.commands.responder --agent-udpv4-endpoint=127.0.0.1:1174 --data-dir=data\srv-dc-03  --quiet

echo.
echo 14 agents started (SW-B2 skipped — simulates DOWN device).
echo Test with: snmpget -v2c -c nw2026 127.0.0.1:1161 1.3.6.1.2.1.1.5.0
echo.
pause
