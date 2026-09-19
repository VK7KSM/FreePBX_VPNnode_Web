package net.elfradio.elfremote;

import org.json.JSONObject;
import java.util.Iterator;

final class TrafficLedger {
    private final JSONObject state;
    TrafficLedger(JSONObject saved) throws Exception {
        state = saved == null ? new JSONObject().put("schema", 1).put("totals", new JSONObject())
                .put("gaps", 0).put("covered_ms", 0) : new JSONObject(saved.toString());
        if (state.getInt("schema") != 1 || state.optJSONObject("totals") == null) throw new IllegalArgumentException("traffic state invalid");
    }

    JSONObject sample(JSONObject counters, String source, String boot, long uptime, long now) throws Exception {
        JSONObject previous = state.optJSONObject("last");
        JSONObject totals = state.getJSONObject("totals");
        boolean same = previous != null && source.equals(state.getString("source")) && boot.equals(state.getString("boot"))
                && uptime >= state.getLong("uptime_ms");
        if (previous != null && !same) state.put("gaps", state.getInt("gaps") + 1);
        boolean reset = false;
        if (same) {
            Iterator<String> oldNames = previous.keys();
            while (oldNames.hasNext()) {
                String name = oldNames.next();
                if (!counters.has(name)) { reset = true; break; }
            }
            for (Iterator<String> names = counters.keys(); names.hasNext();) {
                String name = names.next();
                JSONObject current = counters.getJSONObject(name), old = previous.optJSONObject(name);
                if (old == null) reset = true;
                if (old != null && (current.getLong("rx_bytes") < old.getLong("rx_bytes") || current.getLong("tx_bytes") < old.getLong("tx_bytes"))) reset = true;
            }
            if (reset) state.put("gaps", state.getInt("gaps") + 1);
        }
        // 接口变化只重建该接口基线，其他接口可验证的增量仍须计入。
        if (same) {
            for (Iterator<String> names = counters.keys(); names.hasNext();) {
                String name = names.next();
                JSONObject current = counters.getJSONObject(name), old = previous.optJSONObject(name);
                if (old == null || current.getLong("rx_bytes") < old.getLong("rx_bytes")
                        || current.getLong("tx_bytes") < old.getLong("tx_bytes")) continue;
                JSONObject total = totals.optJSONObject(name);
                if (total == null) total = new JSONObject().put("rx_bytes", 0).put("tx_bytes", 0);
                for (String field : new String[]{"rx_bytes", "tx_bytes"}) {
                    long delta = current.getLong(field) - old.getLong(field);
                    if (delta < 0) throw new IllegalArgumentException("traffic delta invalid");
                    total.put(field, Math.addExact(total.getLong(field), delta));
                }
                totals.put(name, total);
            }
            if (!reset) state.put("covered_ms", Math.addExact(state.getLong("covered_ms"), uptime - state.getLong("uptime_ms")));
        }
        if (!state.has("started_at_ms")) state.put("started_at_ms", now);
        state.put("last", new JSONObject(counters.toString())).put("source", source).put("boot", boot)
                .put("uptime_ms", uptime).put("sampled_at_ms", now);
        long rx = 0, tx = 0;
        for (Iterator<String> names = totals.keys(); names.hasNext();) {
            JSONObject total = totals.getJSONObject(names.next());
            rx = Math.addExact(rx, total.getLong("rx_bytes")); tx = Math.addExact(tx, total.getLong("tx_bytes"));
        }
        return new JSONObject().put("available", true).put("scope", "application_uid").put("source", source)
                .put("started_at_ms", state.getLong("started_at_ms")).put("sampled_at_ms", now)
                .put("covered_ms", state.getLong("covered_ms")).put("gaps", state.getInt("gaps"))
                .put("rx_bytes", rx).put("tx_bytes", tx).put("interfaces", new JSONObject(totals.toString()));
    }

    JSONObject saved() throws Exception { return new JSONObject(state.toString()); }
}
