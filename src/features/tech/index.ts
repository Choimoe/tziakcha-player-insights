import { infoLog } from "../../shared/logger";
import { w } from "../../shared/env";
import { initTechZumgze } from "./zumgze";

let startedTechHref = "";

export function initTechFeature(href: string): boolean {
  if (startedTechHref === href) {
    return false;
  }
  startedTechHref = href;
  infoLog("Tech feature init started");
  w.setTimeout(initTechZumgze, 300);
  return true;
}
