"use strict";

const CACHE_NAME = "mylife-shell-v4";
const APP_BASE = new URL("./", self.registration.scope);
const APP_INDEX = new URL("index.html", APP_BASE).toString();
const API_PREFIX = new URL("api/", APP_BASE).pathname;
const APP_SHELL = ["", "index.html", "styles.css", "app.js", "manifest.json", "icon.svg", "icon-180.png"]
  .map(asset => new URL(asset, APP_BASE).toString());

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== "GET" || requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith(API_PREFIX)) return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
      }
      return response;
    }).catch(async () => {
      const cached = await caches.match(event.request);
      return cached || caches.match(APP_INDEX);
    })
  );
});
