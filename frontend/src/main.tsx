import React from "react";
import { createRoot } from "react-dom/client";
import "@x-happy-x/ui-kit/styles.css";
import App from "./App";
import "./styles/main.scss";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
