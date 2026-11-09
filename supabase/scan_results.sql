-- Run this in Supabase SQL Editor to enable ICMP/ARP scan persistence
create table if not exists scan_results (
  id          uuid        primary key default gen_random_uuid(),
  ip          text        not null,
  mac         text,
  hostname    text,
  scan_type   text        not null default 'icmp',   -- 'icmp' | 'arp' | 'both'
  responded   boolean     not null default false,
  latency_ms  integer,
  scanned_at  timestamptz not null default now()
);
create index if not exists scan_results_scanned_at_idx on scan_results(scanned_at desc);
create index if not exists scan_results_ip_idx         on scan_results(ip);
