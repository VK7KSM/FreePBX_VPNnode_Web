export function installAdminSession() {
  var nativeFetch = window.fetch.bind(window);
  var state = { authenticated: false };
  function expire() {
    state.authenticated = false;
    var form = document.getElementById("loginWrap");
    if (form) form.style.display = "flex";
  }
  try { localStorage.removeItem("_pt"); } catch (_) {}
  window.fetch = function(input, options) {
    return nativeFetch(input, options).then(function(response) {
      var url = new URL(typeof input === "string" ? input : input.url, location.href);
      if (url.origin === location.origin && url.pathname.indexOf("/api/") === 0 && response.status === 401) {
        expire();
        if (url.pathname !== "/api/login" && url.pathname !== "/api/session") throw new Error("登录已失效");
      }
      return response;
    });
  };
  state.check = function(ready) {
    return window.fetch("/api/session", { cache: "no-store" }).then(function(r) { return r.json(); }).then(function(d) {
      state.authenticated = d.ok === true;
      if (state.authenticated) { document.getElementById("loginWrap").style.display = "none"; ready(); }
      else expire();
    }).catch(expire);
  };
  state.accept = function() { state.authenticated = true; };
  state.expire = expire;
  state.logout = function() {
    return window.fetch("/api/logout", { method: "POST" }).then(function(r) {
      if (!r.ok) throw new Error("退出失败");
      expire(); location.href = "/";
    }).catch(function() { alert("退出未完成，请重试"); });
  };
  window.adminSession = state;
}
export const adminSessionSource = "(" + installAdminSession.toString() + ")();";
