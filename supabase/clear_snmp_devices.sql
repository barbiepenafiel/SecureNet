-- Remove fake/seed SNMP devices that are not real physical devices
-- Run this in Supabase SQL Editor

-- Delete devices that were added as SNMP seed data
-- (identified by having snmp_community set, or using fake IP ranges like 10.0.0.x)
DELETE FROM devices
WHERE snmp_community IS NOT NULL
   OR ip LIKE '10.0.0.%'
   OR ip LIKE '10.0.1.%';

-- Also clear any related alerts for those devices
DELETE FROM alerts
WHERE meta ILIKE '%10.0.0.%'
   OR meta ILIKE '%10.0.1.%'
   OR root_cause ILIKE '%SNMP%';

-- Optional: view what's left
SELECT name, type, ip, location, status, snmp_community
FROM devices
ORDER BY name;
