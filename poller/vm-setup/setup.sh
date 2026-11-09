#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# NetWatch — Ubuntu VM SNMP Setup (Option 2)
#
# Run this script on EACH Ubuntu Server 22.04 VM.
# Assign each VM a unique hostname matching your devices.js config.
#
# VirtualBox host-only network: 192.168.56.0/24
# Assign IPs in VirtualBox Network settings or via netplan.
# ─────────────────────────────────────────────────────────────────────────────

set -e

COMMUNITY="nw2026"
HOSTNAME=$(hostname)
IP=$(hostname -I | awk '{print $1}')

echo "Setting up SNMP on $HOSTNAME ($IP)..."

# Install snmpd and iperf3 (for traffic generation)
apt-get update -qq
apt-get install -y snmpd iperf3

# Back up default config
cp /etc/snmp/snmpd.conf /etc/snmp/snmpd.conf.bak

# Write new snmpd.conf
cat > /etc/snmp/snmpd.conf << EOF
# NetWatch NMS — snmpd configuration
# Community string matches devices.js
rocommunity $COMMUNITY 192.168.56.0/24
rocommunity $COMMUNITY 127.0.0.0/8

# System info
sysName    $HOSTNAME
sysContact  it@dnsc.edu.ph
sysLocation DNSC Campus

# Expose all interfaces and disk/CPU/memory stats
view systemonly included .1

# Allow full MIB access for the monitoring community
access notConfigGroup "" any noauth exact all none none
com2sec readonly  192.168.56.0/24  $COMMUNITY
com2sec readonly  127.0.0.0/8      $COMMUNITY
group   MyROGroup  v2c   readonly
view    all        included .1
access  MyROGroup  "" v2c noauth exact all none none

# CPU/memory via hrTable (HOST-RESOURCES-MIB)
# (available by default in net-snmp)

agentAddress udp:161
EOF

# Enable and start
systemctl enable snmpd
systemctl restart snmpd

echo ""
echo "✓ snmpd installed and running on UDP 161"
echo "  Community: $COMMUNITY"
echo "  Test from monitoring host:"
echo "    snmpget -v2c -c $COMMUNITY $IP 1.3.6.1.2.1.1.5.0"
echo ""
echo "To generate real traffic (run on two VMs):"
echo "  VM1 (server): iperf3 -s"
echo "  VM2 (client): iperf3 -c <VM1_IP> -t 3600 -b 10M"
