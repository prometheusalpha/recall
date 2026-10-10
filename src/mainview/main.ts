// Self-hosted so the "DBX default" face in Settings renders offline; the CDN
// variant it replaces needed the network and was already dead code.
import "@fontsource-variable/geist";
import "./styles/globals.css";
import App from "./App.vue";
import { createApp } from "vue";
import { createPinia } from "pinia";

createApp(App).use(createPinia()).mount("#app");
