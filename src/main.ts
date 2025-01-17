import { readFile, mkdir } from "fs/promises";
import { createWriteStream } from "fs";
import { JSDOM } from "jsdom";
import fetch, { Headers } from "node-fetch";
import { argv, exit } from "process";

import type { Config } from "./types";

const args = argv.slice(2);

const configPath = args[0];
if (configPath == null) {
  console.info("\tUSAGE: npm start ./apps.json");
  console.info();
  exit(0);
}

const DEBUG_ENABLED = process.env.DEBUG_ENABLED?.toLowerCase() === "true";

if (!DEBUG_ENABLED) {
  console.debug = () => {};
}

let config: Config;
try {
  const json = await readFile(configPath, { encoding: "utf-8" });
  config = JSON.parse(json);
} catch (error) {
  throw new Error(
    "Couln't parse config file, make sure you provided the correct path and the file contains valid json"
  );
}

const baseURL = "https://apkmirror.com";

const headers = new Headers({
  authority: "www.apkmirror.com",
  "user-agent": "Mozilla/5.0 Chrome/81.0.4044.113 Safari/537.36",
});

const downloadFunctions = [
  getNonBundleURL,
  getDownloadPageURL,
  getDirectDownloadURL,
];

const downloads = config.apps.map(({ packageName, urlPath, version, arch }) =>
  downloadApp(packageName, urlPath, arch, version)
);
await Promise.allSettled(downloads);

async function downloadApp(
  name: string,
  urlPath: string,
  arch: string,
  version?: string
): Promise<void> {
  if (!name || !urlPath)
    throw new Error("At least one empty argument was passed to this function");

  let document;
  let url = new URL(urlPath, baseURL);

  if (version) {
    document = await getDocumentFromURL(url);
    urlPath = getCustomVersionURL(version, document);
  } else {
    document = await getDocumentFromURL(url);
    [urlPath, version] = getLatestStableURL(document);
  }

  console.log(`Fetched Version URL: ${new URL(urlPath, baseURL)}`);

  for (const dlFunc of downloadFunctions) {
    url = new URL(urlPath, baseURL);
    document = await getDocumentFromURL(url);
    urlPath = dlFunc(document, arch);
  }

  console.log(`APK Download URL: ${new URL(urlPath, baseURL)}`);
  await download(name, new URL(urlPath, baseURL), arch, version);
}

function getLatestStableURL(document: Document): [string, string] {
  const containers = queryAll(document.body, ".listWidget");
  const versionContainer = findContainerWithHeading(containers, "All versions");
  const versions = queryAll(
    versionContainer,
    ".appRow .appRowTitle > a"
  ) as NodeListOf<HTMLAnchorElement>;

  Array.from(versions).forEach((anchorElement, index) => {
    console.debug(`Anchor Element ${index + 1}:`);
    console.debug("Href:", anchorElement.href);
    console.debug("Text Content:", anchorElement.textContent);
    console.debug("-----------------------------");
  });

  const latestStable = Array.from(versions)
    .filter((x) => x != null)
    .find((x) => {
      return !(
        x.textContent?.toLowerCase().includes("alpha") ||
        x.textContent?.toLowerCase().includes("beta")
      );
    });

  if (latestStable == null) {
    const moreUploads = versionContainer.querySelector(
      ":scope > :last-child a"
    ) as HTMLAnchorElement | null;
    if (moreUploads != null) {
      console.error(
        `Here you can manually browse the latest APKs: ${moreUploads.href}`
      );
    }
    throw new Error("Couldn't find anchor element for latest stable APK");
  }
  const version = latestStable.textContent?.match(/[\d.]+/)?.[0] || "unknown";
  console.debug(`Latest Stable Version: ${version}`);

  return [latestStable.href, version];
}

function getCustomVersionURL(version: string, document: Document): string {
  const containers = queryAll(document.body, ".listWidget");
  const versionContainer = findContainerWithHeading(containers, "All versions");
  const versions = queryAll(
    versionContainer,
    ".appRow .appRowTitle > a"
  ) as NodeListOf<HTMLAnchorElement>;

  const customVersion = Array.from(versions)
    .filter((x) => x != null)
    .find((x) => x.textContent?.toLowerCase().includes(version));

  if (customVersion == null) {
    const moreUploads = versionContainer.querySelector(
      ":scope > :last-child a"
    ) as HTMLAnchorElement | null;
    if (moreUploads != null) {
      console.error(
        `Here you can manually browse the latest APKs: ${moreUploads.href}`
      );
    }
    throw new Error("Couldn't find anchor element for latest stable APK");
  }

  return customVersion.href;
}

function getNonBundleURL(document: Document, arch: string): string {
  const containers = queryAll(document.body, ".listWidget");
  const downloadContainer = findContainerWithHeading(containers, "Download");
  const downloads = queryAll(
    downloadContainer,
    ":scope > :last-child a"
  ) as NodeListOf<HTMLAnchorElement>;

  const nonBundleDownload = Array.from(downloads)
    .filter((x) => x != null)
    .filter((x) => {
      const length = x.parentElement?.children.length;
      return length != null && length > 1;
    })
    .filter((x) => {
      if (arch) {
        const mainEl = x.parentElement?.parentElement;
        const archEl = mainEl?.children?.[1];
        const arch = archEl?.textContent;
        return arch == arch || arch == "universal";
      } else {
        return true;
      }
    })
    .find((x) => {
      const badges = queryAll(x.parentElement, ".apkm-badge");
      const isBundle = Array.from(badges).some((x) =>
        x.textContent?.toLowerCase().includes("bundle")
      );
      return !isBundle;
    });

  if (nonBundleDownload == null) {
    throw new Error("Couldn't find anchor element for normal/non-bundled APK");
  }

  return nonBundleDownload.href;
}

function getDownloadPageURL(document: Document): string {
  const downloadPageButton = document.querySelector(
    ".card-with-tabs .tab-content #file a.downloadButton"
  ) as HTMLAnchorElement | null;
  if (downloadPageButton == null)
    throw new Error("Couldn't find anchor element for APK download page");
  return downloadPageButton.href;
}

function getDirectDownloadURL(document: Document): string {
  const directDownloadButton = document.querySelector(
    ".card-with-tabs a"
  ) as HTMLAnchorElement | null;
  if (directDownloadButton == null)
    throw new Error("Couldn't find anchor element for direct APK download");
  return directDownloadButton.href;
}

function findContainerWithHeading(
  list: NodeListOf<Element>,
  text: string
): Element {
  const result = Array.from(list).find((x) =>
    x.querySelector(":scope > .widgetHeader")?.textContent?.includes(text)
  );
  if (result == null)
    throw new Error("Couldn't find container with matching heading");
  return result;
}

function queryAll(
  element: Element | null,
  selectors: string
): NodeListOf<Element> {
  const list = element?.querySelectorAll(selectors);
  if (list == null || list.length === 0)
    throw new Error("Couldn't find a matching element for selector");
  return list;
}

async function getDocumentFromURL(url: URL): Promise<Document> {
  const response = await fetch(url.href, { headers: headers });
  const text = await response.text();
  const root = new JSDOM(text).window.document;
  if (root == null)
    throw new Error("An error occurred while trying to parse the page");
  return root;
}

async function download(
  name: string,
  url: URL,
  arch: string,
  version: string
): Promise<void> {
  const dl = fetch(url.href, { headers: headers });
  const path = `apps/${name}_${arch}_${version}.apk`;
  await mkdir("apps", { recursive: true });
  const response = await dl;
  const contentType = response.headers.get("Content-Type");
  const isAPK = contentType == "application/vnd.android.package-archive";
  const body = response.body;
  if (body != null && isAPK) {
    const fileStream = createWriteStream(path);
    body.pipe(fileStream);
  } else {
    throw new Error("An error occurred while trying to download the file");
  }
}
