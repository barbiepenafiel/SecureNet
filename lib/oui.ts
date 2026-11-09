// MAC OUI (first 3 bytes) → vendor + inferred device type
// Source: IEEE public OUI registry — common campus / SOHO networking gear

export type DeviceGuess = {
  vendor: string
  device_type: 'Router' | 'Access Point' | 'Switch' | 'Server' | 'Client' | 'Unknown'
}

// Key = first 6 hex chars of MAC, uppercase, no separators (e.g. "AABBCC")
const OUI_TABLE: Record<string, DeviceGuess> = {
  // ── TP-Link ───────────────────────────────────────────────────────────────
  '50C7BF': { vendor: 'TP-Link', device_type: 'Router' },
  '1C3BF3': { vendor: 'TP-Link', device_type: 'Router' },
  '2C4D54': { vendor: 'TP-Link', device_type: 'Router' },
  '50BD5F': { vendor: 'TP-Link', device_type: 'Router' },
  '60A4B7': { vendor: 'TP-Link', device_type: 'Router' },
  'B0487A': { vendor: 'TP-Link', device_type: 'Router' },
  'D80D17': { vendor: 'TP-Link', device_type: 'Router' },
  'E8DE27': { vendor: 'TP-Link', device_type: 'Access Point' },
  'A860B6': { vendor: 'TP-Link', device_type: 'Access Point' },
  '782BE4': { vendor: 'TP-Link', device_type: 'Router' },
  '54C80F': { vendor: 'TP-Link', device_type: 'Router' },
  'B4B024': { vendor: 'TP-Link', device_type: 'Router' },
  'F4EC38': { vendor: 'TP-Link', device_type: 'Access Point' },
  '002722': { vendor: 'TP-Link', device_type: 'Router' },
  '00237A': { vendor: 'TP-Link', device_type: 'Router' },
  '304A18': { vendor: 'TP-Link', device_type: 'Router' },
  '44D3CA': { vendor: 'TP-Link', device_type: 'Router' },
  '586D8F': { vendor: 'TP-Link', device_type: 'Router' },
  '5C628B': { vendor: 'TP-Link', device_type: 'Router' },
  '807B85': { vendor: 'TP-Link', device_type: 'Router' },
  '9C4E36': { vendor: 'TP-Link', device_type: 'Access Point' },
  'C025A2': { vendor: 'TP-Link', device_type: 'Router' },
  'EC172F': { vendor: 'TP-Link', device_type: 'Router' },
  'F46D04': { vendor: 'TP-Link', device_type: 'Router' },
  'A42BB0': { vendor: 'TP-Link', device_type: 'Access Point' },
  '1C61B4': { vendor: 'TP-Link', device_type: 'Router' },
  '148F21': { vendor: 'TP-Link', device_type: 'Router' },
  '102466': { vendor: 'TP-Link', device_type: 'Router' },
  '30B49E': { vendor: 'TP-Link', device_type: 'Router' },

  // ── D-Link ────────────────────────────────────────────────────────────────
  '1C7EE5': { vendor: 'D-Link', device_type: 'Router' },
  'B8A386': { vendor: 'D-Link', device_type: 'Router' },
  'C0A0BB': { vendor: 'D-Link', device_type: 'Router' },
  '00265A': { vendor: 'D-Link', device_type: 'Switch' },
  '001195': { vendor: 'D-Link', device_type: 'Switch' },
  '14D64D': { vendor: 'D-Link', device_type: 'Router' },
  '283B82': { vendor: 'D-Link', device_type: 'Router' },
  '84C9B2': { vendor: 'D-Link', device_type: 'Router' },
  'F0B4D2': { vendor: 'D-Link', device_type: 'Router' },
  'CC2D83': { vendor: 'D-Link', device_type: 'Access Point' },

  // ── Cisco ─────────────────────────────────────────────────────────────────
  '001A2F': { vendor: 'Cisco', device_type: 'Router' },
  '002564': { vendor: 'Cisco', device_type: 'Router' },
  '0025B4': { vendor: 'Cisco', device_type: 'Router' },
  '003A99': { vendor: 'Cisco', device_type: 'Router' },
  '0050F2': { vendor: 'Cisco', device_type: 'Switch' },
  '00E0F9': { vendor: 'Cisco', device_type: 'Router' },
  '1C6A7A': { vendor: 'Cisco', device_type: 'Router' },
  '2CB859': { vendor: 'Cisco', device_type: 'Router' },
  '3C0896': { vendor: 'Cisco', device_type: 'Router' },
  '4C4E35': { vendor: 'Cisco', device_type: 'Router' },
  '6400F1': { vendor: 'Cisco', device_type: 'Router' },
  '70CA9B': { vendor: 'Cisco', device_type: 'Router' },
  '84B2B2': { vendor: 'Cisco', device_type: 'Router' },
  'A80C0D': { vendor: 'Cisco', device_type: 'Router' },
  'C4712E': { vendor: 'Cisco', device_type: 'Router' },
  'E48D8C': { vendor: 'Cisco', device_type: 'Router' },
  'F872EA': { vendor: 'Cisco', device_type: 'Router' },

  // ── Ubiquiti ──────────────────────────────────────────────────────────────
  '0027FF': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  '00156D': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  '042569': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  '246895': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  '44D9E7': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  '687246': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  '788A20': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  '802AA8': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  'B4FBE4': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  'DC9FDB': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  'E063DA': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  'F09FC2': { vendor: 'Ubiquiti', device_type: 'Access Point' },
  'FCECDA': { vendor: 'Ubiquiti', device_type: 'Access Point' },

  // ── Netgear ───────────────────────────────────────────────────────────────
  '001B2F': { vendor: 'Netgear', device_type: 'Router' },
  '00146C': { vendor: 'Netgear', device_type: 'Router' },
  '00224B': { vendor: 'Netgear', device_type: 'Router' },
  '20E52A': { vendor: 'Netgear', device_type: 'Router' },
  '28C68E': { vendor: 'Netgear', device_type: 'Router' },
  '2C3033': { vendor: 'Netgear', device_type: 'Router' },
  '44940C': { vendor: 'Netgear', device_type: 'Router' },
  '6CB0CE': { vendor: 'Netgear', device_type: 'Router' },
  '9C3426': { vendor: 'Netgear', device_type: 'Router' },
  'A021B7': { vendor: 'Netgear', device_type: 'Router' },
  'C03F0E': { vendor: 'Netgear', device_type: 'Router' },
  'E091F5': { vendor: 'Netgear', device_type: 'Router' },

  // ── Asus ──────────────────────────────────────────────────────────────────
  '048D38': { vendor: 'Asus', device_type: 'Router' },
  '107B44': { vendor: 'Asus', device_type: 'Router' },
  '2C56DC': { vendor: 'Asus', device_type: 'Router' },
  '3497F6': { vendor: 'Asus', device_type: 'Router' },
  '50465D': { vendor: 'Asus', device_type: 'Router' },
  '6045CB': { vendor: 'Asus', device_type: 'Router' },
  '74D02B': { vendor: 'Asus', device_type: 'Router' },
  '90E6BA': { vendor: 'Asus', device_type: 'Router' },
  'AC220B': { vendor: 'Asus', device_type: 'Router' },
  'F832E4': { vendor: 'Asus', device_type: 'Router' },

  // ── MikroTik ──────────────────────────────────────────────────────────────
  '2CC8D9': { vendor: 'MikroTik', device_type: 'Router' },
  '4C5E0C': { vendor: 'MikroTik', device_type: 'Router' },
  '6C3B6B': { vendor: 'MikroTik', device_type: 'Router' },
  '74AD0C': { vendor: 'MikroTik', device_type: 'Router' },
  'B8690A': { vendor: 'MikroTik', device_type: 'Router' },
  'CC2DE0': { vendor: 'MikroTik', device_type: 'Router' },
  'D4CA6D': { vendor: 'MikroTik', device_type: 'Router' },
  'E48027': { vendor: 'MikroTik', device_type: 'Router' },
  '48A97E': { vendor: 'MikroTik', device_type: 'Router' },

  // ── Aruba / HPE ───────────────────────────────────────────────────────────
  '001A1E': { vendor: 'Aruba', device_type: 'Access Point' },
  '0004F2': { vendor: 'Aruba', device_type: 'Access Point' },
  '00247B': { vendor: 'Aruba', device_type: 'Access Point' },
  '1C8B2E': { vendor: 'Aruba', device_type: 'Access Point' },
  '20A6CD': { vendor: 'Aruba', device_type: 'Access Point' },
  '24DE C6': { vendor: 'Aruba', device_type: 'Access Point' },
  '40E3D6': { vendor: 'Aruba', device_type: 'Access Point' },
  '6C7220': { vendor: 'Aruba', device_type: 'Access Point' },
  '84D47E': { vendor: 'Aruba', device_type: 'Access Point' },
  '9C8CD8': { vendor: 'Aruba', device_type: 'Access Point' },
  'D8C7C8': { vendor: 'Aruba', device_type: 'Access Point' },

  // ── HP / HPE (switches & servers) ────────────────────────────────────────
  '001083': { vendor: 'HP', device_type: 'Switch' },
  '0017A4': { vendor: 'HP', device_type: 'Switch' },
  '001CC4': { vendor: 'HP', device_type: 'Server' },
  '1C98EC': { vendor: 'HP', device_type: 'Server' },
  '3C4A92': { vendor: 'HP', device_type: 'Server' },
  'A0B3CC': { vendor: 'HP', device_type: 'Server' },
  'B499BA': { vendor: 'HP', device_type: 'Switch' },
  'EC8EB5': { vendor: 'HP', device_type: 'Switch' },

  // ── Juniper ───────────────────────────────────────────────────────────────
  '0019E2': { vendor: 'Juniper', device_type: 'Router' },
  '0021590': { vendor: 'Juniper', device_type: 'Router' },
  '2C6BF5': { vendor: 'Juniper', device_type: 'Switch' },
  '5C5015': { vendor: 'Juniper', device_type: 'Switch' },

  // ── Dell ─────────────────────────────────────────────────────────────────
  '001372': { vendor: 'Dell', device_type: 'Server' },
  '0015C5': { vendor: 'Dell', device_type: 'Server' },
  '1418C3': { vendor: 'Dell', device_type: 'Server' },
  '34179E': { vendor: 'Dell', device_type: 'Server' },
  'B083FE': { vendor: 'Dell', device_type: 'Server' },
  'F48E38': { vendor: 'Dell', device_type: 'Server' },
  'F8DB88': { vendor: 'Dell', device_type: 'Server' },

  // ── Intel (usually PC/laptop NICs) ───────────────────────────────────────
  '001B21': { vendor: 'Intel', device_type: 'Client' },
  '001E67': { vendor: 'Intel', device_type: 'Client' },
  '00269E': { vendor: 'Intel', device_type: 'Client' },
  '10027B': { vendor: 'Intel', device_type: 'Client' },
  '24777E': { vendor: 'Intel', device_type: 'Client' },
  '386077': { vendor: 'Intel', device_type: 'Client' },
  '40A36B': { vendor: 'Intel', device_type: 'Client' },
  '48515B': { vendor: 'Intel', device_type: 'Client' },
  '50769F': { vendor: 'Intel', device_type: 'Client' },
  '5CF951': { vendor: 'Intel', device_type: 'Client' },
  '7085C2': { vendor: 'Intel', device_type: 'Client' },
  '8086F2': { vendor: 'Intel', device_type: 'Client' },
  'A4C3F0': { vendor: 'Intel', device_type: 'Client' },
  'B88684': { vendor: 'Intel', device_type: 'Client' },
  'D8FC93': { vendor: 'Intel', device_type: 'Client' },

  // ── Apple ─────────────────────────────────────────────────────────────────
  '000A27': { vendor: 'Apple', device_type: 'Client' },
  '000D93': { vendor: 'Apple', device_type: 'Client' },
  '001124': { vendor: 'Apple', device_type: 'Client' },
  '001451': { vendor: 'Apple', device_type: 'Client' },
  '0017F2': { vendor: 'Apple', device_type: 'Client' },
  '001CB3': { vendor: 'Apple', device_type: 'Client' },
  '002332': { vendor: 'Apple', device_type: 'Client' },
  '0026B9': { vendor: 'Apple', device_type: 'Client' },
  '003065': { vendor: 'Apple', device_type: 'Client' },
  '10DDB1': { vendor: 'Apple', device_type: 'Client' },
  '281878': { vendor: 'Apple', device_type: 'Client' },
  '3C0754': { vendor: 'Apple', device_type: 'Client' },
  '48A195': { vendor: 'Apple', device_type: 'Client' },
  '5C5948': { vendor: 'Apple', device_type: 'Client' },
  '78D75F': { vendor: 'Apple', device_type: 'Client' },
  '8C2DAA': { vendor: 'Apple', device_type: 'Client' },
  'A8BE27': { vendor: 'Apple', device_type: 'Client' },
  'B88D12': { vendor: 'Apple', device_type: 'Client' },
  'D0E140': { vendor: 'Apple', device_type: 'Client' },
  'F0DCE2': { vendor: 'Apple', device_type: 'Client' },

  // ── Samsung ───────────────────────────────────────────────────────────────
  '002339': { vendor: 'Samsung', device_type: 'Client' },
  '00264D': { vendor: 'Samsung', device_type: 'Client' },
  '08D42B': { vendor: 'Samsung', device_type: 'Client' },
  '10D542': { vendor: 'Samsung', device_type: 'Client' },
  '2C0E3D': { vendor: 'Samsung', device_type: 'Client' },
  '30CD9E': { vendor: 'Samsung', device_type: 'Client' },
  '40B836': { vendor: 'Samsung', device_type: 'Client' },
  '5C3C27': { vendor: 'Samsung', device_type: 'Client' },
  '78F7BE': { vendor: 'Samsung', device_type: 'Client' },
  '90181A': { vendor: 'Samsung', device_type: 'Client' },
  'A8F274': { vendor: 'Samsung', device_type: 'Client' },
  'CC07AB': { vendor: 'Samsung', device_type: 'Client' },
  'E8039A': { vendor: 'Samsung', device_type: 'Client' },

  // ── Realtek (embedded / IoT / cheap adapters) ────────────────────────────
  '00E04C': { vendor: 'Realtek', device_type: 'Client' },
  'E09051': { vendor: 'Realtek', device_type: 'Client' },
  '30DE4B': { vendor: 'Realtek', device_type: 'Client' },

  // ── Espressif (IoT / ESP8266, ESP32) ─────────────────────────────────────
  '240AC4': { vendor: 'Espressif (IoT)', device_type: 'Unknown' },
  '30AEA4': { vendor: 'Espressif (IoT)', device_type: 'Unknown' },
  '48E72A': { vendor: 'Espressif (IoT)', device_type: 'Unknown' },
  '58BF25': { vendor: 'Espressif (IoT)', device_type: 'Unknown' },
  '807D3A': { vendor: 'Espressif (IoT)', device_type: 'Unknown' },
  'A020A6': { vendor: 'Espressif (IoT)', device_type: 'Unknown' },
  'CC50E3': { vendor: 'Espressif (IoT)', device_type: 'Unknown' },

  // ── Raspberry Pi ─────────────────────────────────────────────────────────
  'B827EB': { vendor: 'Raspberry Pi', device_type: 'Server' },
  'DCA632': { vendor: 'Raspberry Pi', device_type: 'Server' },
  'E45F01': { vendor: 'Raspberry Pi', device_type: 'Server' },

  // ── Huawei ───────────────────────────────────────────────────────────────
  'A82948': { vendor: 'Huawei', device_type: 'Router' },
  '001E10': { vendor: 'Huawei', device_type: 'Router' },
  '0025D3': { vendor: 'Huawei', device_type: 'Router' },
  '081086': { vendor: 'Huawei', device_type: 'Router' },
  '10C61F': { vendor: 'Huawei', device_type: 'Router' },
  '1C8E5C': { vendor: 'Huawei', device_type: 'Router' },
  '248014': { vendor: 'Huawei', device_type: 'Router' },
  '288023': { vendor: 'Huawei', device_type: 'Router' },
  '30067B': { vendor: 'Huawei', device_type: 'Router' },
  '346BD3': { vendor: 'Huawei', device_type: 'Router' },
  '4C1FAA': { vendor: 'Huawei', device_type: 'Router' },
  '5C4CA9': { vendor: 'Huawei', device_type: 'Router' },
  '606993': { vendor: 'Huawei', device_type: 'Router' },
  '68A0F6': { vendor: 'Huawei', device_type: 'Router' },
  '704ABF': { vendor: 'Huawei', device_type: 'Router' },
  '78D752': { vendor: 'Huawei', device_type: 'Router' },
  '807B85': { vendor: 'Huawei', device_type: 'Router' },
  '8C34FD': { vendor: 'Huawei', device_type: 'Router' },
  '9C37F4': { vendor: 'Huawei', device_type: 'Router' },
  'BC7670': { vendor: 'Huawei', device_type: 'Router' },
  'C40304': { vendor: 'Huawei', device_type: 'Router' },
  'DC729C': { vendor: 'Huawei', device_type: 'Router' },
  'F4DC5D': { vendor: 'Huawei', device_type: 'Router' },
  'F4E37D': { vendor: 'Huawei', device_type: 'Router' },
  'FC48EF': { vendor: 'Huawei', device_type: 'Router' },
  '0C8112': { vendor: 'Huawei', device_type: 'Router' },
  '20F17C': { vendor: 'Huawei', device_type: 'Router' },
  '309C23': { vendor: 'Huawei', device_type: 'Router' },
  '48DB50': { vendor: 'Huawei', device_type: 'Router' },
  '703AC3': { vendor: 'Huawei', device_type: 'Router' },
  '84BE52': { vendor: 'Huawei', device_type: 'Router' },
  'AC853D': { vendor: 'Huawei', device_type: 'Router' },
  'B4430D': { vendor: 'Huawei', device_type: 'Router' },

  // ── HONOR / Huawei mobile ─────────────────────────────────────────────────
  'C8B2F5': { vendor: 'Honor', device_type: 'Client' },
  '509FA9': { vendor: 'Honor', device_type: 'Client' },

  // ── Xiaomi / Redmi ────────────────────────────────────────────────────────
  '0C1DAF': { vendor: 'Xiaomi', device_type: 'Router' },
  '28D1273': { vendor: 'Xiaomi', device_type: 'Router' },
  '34CE00': { vendor: 'Xiaomi', device_type: 'Router' },
  '50EC50': { vendor: 'Xiaomi', device_type: 'Client' },
  '5C9A02': { vendor: 'Xiaomi', device_type: 'Client' },
  '64B473': { vendor: 'Xiaomi', device_type: 'Client' },
  '74051B': { vendor: 'Xiaomi', device_type: 'Client' },
  '7811DC': { vendor: 'Xiaomi', device_type: 'Client' },
  '8C97EA': { vendor: 'Xiaomi', device_type: 'Router' },
  '98FAE3': { vendor: 'Xiaomi', device_type: 'Client' },
  'A45840': { vendor: 'Xiaomi', device_type: 'Client' },
  'C46AB7': { vendor: 'Xiaomi', device_type: 'Client' },
  'F48B32': { vendor: 'Xiaomi', device_type: 'Client' },
  'FC64BA': { vendor: 'Xiaomi', device_type: 'Client' },
  '28E31F': { vendor: 'Xiaomi', device_type: 'Client' },
  'AC2374': { vendor: 'Xiaomi', device_type: 'Router' },
  '00EC0A': { vendor: 'Xiaomi', device_type: 'Router' },

  // ── OPPO / Realme / OnePlus ───────────────────────────────────────────────
  'FC23CD': { vendor: 'OPPO', device_type: 'Client' },
  '00F4EB': { vendor: 'OPPO', device_type: 'Client' },
  '1C77F6': { vendor: 'OPPO', device_type: 'Client' },
  '44C526': { vendor: 'OPPO', device_type: 'Client' },
  '549F13': { vendor: 'OPPO', device_type: 'Client' },
  '7471A3': { vendor: 'OPPO', device_type: 'Client' },
  'A8A15D': { vendor: 'OPPO', device_type: 'Client' },
  'BC1760': { vendor: 'OPPO', device_type: 'Client' },
  'EC3D95': { vendor: 'OPPO', device_type: 'Client' },
  'CC2D83': { vendor: 'Realme', device_type: 'Client' },

  // ── Vivo ──────────────────────────────────────────────────────────────────
  '100B6B': { vendor: 'Vivo', device_type: 'Client' },
  '1C87E8': { vendor: 'Vivo', device_type: 'Client' },
  '30AB6A': { vendor: 'Vivo', device_type: 'Client' },
  '48021C': { vendor: 'Vivo', device_type: 'Client' },
  'B85E7B': { vendor: 'Vivo', device_type: 'Client' },
  'D0294B': { vendor: 'Vivo', device_type: 'Client' },

  // ── Lenovo ────────────────────────────────────────────────────────────────
  '001EAE': { vendor: 'Lenovo', device_type: 'Client' },
  '107D1A': { vendor: 'Lenovo', device_type: 'Client' },
  '28D244': { vendor: 'Lenovo', device_type: 'Client' },
  '4C5F7C': { vendor: 'Lenovo', device_type: 'Client' },
  '6CF049': { vendor: 'Lenovo', device_type: 'Client' },
  '70720D': { vendor: 'Lenovo', device_type: 'Client' },
  '885D90': { vendor: 'Lenovo', device_type: 'Client' },
  '9C4EA0': { vendor: 'Lenovo', device_type: 'Client' },
  'A44CC8': { vendor: 'Lenovo', device_type: 'Client' },
  'C8DDC9': { vendor: 'Lenovo', device_type: 'Client' },
  'F44701': { vendor: 'Lenovo', device_type: 'Client' },
  '0021CC': { vendor: 'Lenovo', device_type: 'Server' },

  // ── Microsoft / Surface ───────────────────────────────────────────────────
  '7C1E52': { vendor: 'Microsoft', device_type: 'Client' },
  '00155D': { vendor: 'Microsoft', device_type: 'Client' },
  '281878': { vendor: 'Microsoft', device_type: 'Client' },
  '3417EB': { vendor: 'Microsoft', device_type: 'Client' },

  // ── Qualcomm Atheros ─────────────────────────────────────────────────────
  '001374': { vendor: 'Qualcomm Atheros', device_type: 'Client' },
  '0026CB': { vendor: 'Qualcomm Atheros', device_type: 'Client' },
  '10027B': { vendor: 'Qualcomm Atheros', device_type: 'Client' },
  '606BFF': { vendor: 'Qualcomm Atheros', device_type: 'Client' },
  '8CFDF0': { vendor: 'Qualcomm Atheros', device_type: 'Client' },
  'A88B4A': { vendor: 'Qualcomm Atheros', device_type: 'Client' },
  'E0CB4E': { vendor: 'Qualcomm Atheros', device_type: 'Client' },

  // ── Broadcom ──────────────────────────────────────────────────────────────
  '001018': { vendor: 'Broadcom', device_type: 'Client' },
  '00264B': { vendor: 'Broadcom', device_type: 'Client' },
  '00904C': { vendor: 'Broadcom', device_type: 'Client' },
  '204E7F': { vendor: 'Broadcom', device_type: 'Client' },

  // ── MediaTek ─────────────────────────────────────────────────────────────
  '00904C': { vendor: 'MediaTek', device_type: 'Router' },
  '0C8112': { vendor: 'MediaTek', device_type: 'Router' },
  '784B87': { vendor: 'MediaTek', device_type: 'Router' },
  'E4BEED': { vendor: 'MediaTek', device_type: 'Router' },

  // ── Nintendo ──────────────────────────────────────────────────────────────
  '001656': { vendor: 'Nintendo', device_type: 'Client' },
  '00224C': { vendor: 'Nintendo', device_type: 'Client' },
  '002659': { vendor: 'Nintendo', device_type: 'Client' },
  '7CBB8A': { vendor: 'Nintendo', device_type: 'Client' },
  '98B6E9': { vendor: 'Nintendo', device_type: 'Client' },

  // ── Sony PlayStation ──────────────────────────────────────────────────────
  '001315': { vendor: 'Sony PlayStation', device_type: 'Client' },
  '00D9D1': { vendor: 'Sony PlayStation', device_type: 'Client' },
  '709E29': { vendor: 'Sony PlayStation', device_type: 'Client' },
  'F8461C': { vendor: 'Sony PlayStation', device_type: 'Client' },

  // ── Google ────────────────────────────────────────────────────────────────
  'F4F5E8': { vendor: 'Google', device_type: 'Client' },
  '3C5AB4': { vendor: 'Google', device_type: 'Client' },
  '48D705': { vendor: 'Google', device_type: 'Client' },
  '54607E': { vendor: 'Google', device_type: 'Client' },
  'A4977A': { vendor: 'Google', device_type: 'Client' },

  // ── Amazon ────────────────────────────────────────────────────────────────
  '0C4733': { vendor: 'Amazon', device_type: 'Client' },
  '44650D': { vendor: 'Amazon', device_type: 'Client' },
  '74C246': { vendor: 'Amazon', device_type: 'Client' },
  'A002DC': { vendor: 'Amazon', device_type: 'Client' },
  'F0272D': { vendor: 'Amazon', device_type: 'Client' },
  'FCA667': { vendor: 'Amazon', device_type: 'Client' },

  // ── Texas Instruments (IoT) ───────────────────────────────────────────────
  '00123B': { vendor: 'Texas Instruments', device_type: 'Unknown' },
  '0017EB': { vendor: 'Texas Instruments', device_type: 'Unknown' },
  '0050C2': { vendor: 'Texas Instruments', device_type: 'Unknown' },
  '7CC311': { vendor: 'Texas Instruments', device_type: 'Unknown' },
  'D4F64A': { vendor: 'Texas Instruments', device_type: 'Unknown' },
}

const UNKNOWN: DeviceGuess = { vendor: 'Unknown', device_type: 'Unknown' }

/**
 * Returns vendor + inferred device type from a MAC address.
 * mac can be in any separator format: "AA:BB:CC:DD:EE:FF" or "AA-BB-CC-DD-EE-FF"
 * ip is used as a fallback heuristic when MAC lookup fails (e.g. .1 / .254 = Router)
 */
export function lookupOui(mac: string | null, ip?: string): DeviceGuess {
  if (!mac && !ip) return UNKNOWN

  // Try MAC table first
  if (mac) {
    const oui = mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase().slice(0, 6)
    if (oui.length >= 6) {
      const hit = OUI_TABLE[oui]
      if (hit) return hit
    }
  }

  // IP-based heuristic: gateway addresses are almost always routers
  if (ip) {
    const lastOctet = parseInt(ip.split('.').pop() ?? '0', 10)
    if (lastOctet === 1 || lastOctet === 254)
      return { vendor: 'Router / Gateway', device_type: 'Router' }
    if (lastOctet === 2)
      return { vendor: 'Gateway', device_type: 'Router' }
  }

  return UNKNOWN
}
