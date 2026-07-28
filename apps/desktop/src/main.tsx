import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { purgeLegacySecrets } from "./store.js";
import "./styles.css";

// runs before anything else, every launch — see purgeLegacySecrets
purgeLegacySecrets();

createRoot(document.getElementById("root")!).render(<App />);
