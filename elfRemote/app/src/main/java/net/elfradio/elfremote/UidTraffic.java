package net.elfradio.elfremote;

import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.Reader;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

final class UidTraffic {
    static JSONObject parse(Reader source, int uid) throws Exception {
        BufferedReader reader = new BufferedReader(source);
        String header = reader.readLine();
        if (header == null) throw new IOException("traffic header missing");
        Map<String,Integer> columns = new HashMap<>();
        String[] names = header.trim().split("\\s+");
        for (int i = 0; i < names.length; i++) columns.put(names[i], i);
        for (String field : new String[]{"iface", "uid_tag_int", "acct_tag_hex", "cnt_set", "rx_bytes", "tx_bytes"})
            if (!columns.containsKey(field)) throw new IOException("traffic header unsupported");
        JSONObject result = new JSONObject();
        Set<String> seen = new HashSet<>();
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.trim().isEmpty()) continue;
            String[] values = line.trim().split("\\s+");
            if (values.length != names.length) throw new IOException("traffic row truncated");
            if (Integer.parseInt(values[columns.get("uid_tag_int")]) != uid) continue;
            // tag=0 已包含带标签子流量，不能把子标签再次相加。
            if (!values[columns.get("acct_tag_hex")].matches("0x0+")) continue;
            String iface = values[columns.get("iface")];
            if("lo".equals(iface))continue;
            if (!iface.matches("[A-Za-z0-9_.:-]{1,32}") || !seen.add(iface + ":" + values[columns.get("cnt_set")]))
                throw new IOException("traffic row duplicated or invalid");
            long rx = Long.parseLong(values[columns.get("rx_bytes")]), tx = Long.parseLong(values[columns.get("tx_bytes")]);
            if (rx < 0 || tx < 0) throw new IOException("traffic counter invalid");
            JSONObject previous = result.optJSONObject(iface);
            result.put(iface, new JSONObject().put("rx_bytes", Math.addExact(rx, previous == null ? 0 : previous.getLong("rx_bytes")))
                    .put("tx_bytes", Math.addExact(tx, previous == null ? 0 : previous.getLong("tx_bytes"))));
        }
        return result;
    }

    private UidTraffic() {}
}
