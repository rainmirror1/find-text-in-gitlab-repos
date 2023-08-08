#!/usr/bin/env node

import fetch from "node-fetch";
import { pipeline } from "node:stream/promises";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout } from 'timers/promises';
import tar from "tar-stream";
import zlib from "zlib";
import readline from "readline";
import chalk from "chalk";

const gitLabBaseUrl = "https://gitlab.com/api/v4";
const gitLabToken = "{access_toke}"; //TODO: password prompt for access token
const headers = {
  "Private-Token": gitLabToken,
};

const repos = [];

const printMemUsage = () => {
  const formatMemoryUsage = (data) =>
    `${Math.round((data / 1024 / 1024) * 100) / 100} MB`;
  const memoryData = process.memoryUsage();

  const memoryUsage = {
    rss: `${formatMemoryUsage(
      memoryData.rss
    )} -> Resident Set Size - total memory allocated for the process execution`,
    heapTotal: `${formatMemoryUsage(
      memoryData.heapTotal
    )} -> total size of the allocated heap`,
    heapUsed: `${formatMemoryUsage(
      memoryData.heapUsed
    )} -> actual memory used during the execution`,
    external: `${formatMemoryUsage(memoryData.external)} -> V8 external memory`,
  };

  console.debug(memoryUsage);
};

const fetchSubgroupByGroupId = async (groupId) => {
  const url = `${gitLabBaseUrl}/groups/${encodeURIComponent(groupId)}/subgroups`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch subgroup: ${response.status} ${response.statusText}`
    );
  }
  return response.json();
};

const fetchProjectsUnderGroup = async (groupId) => {
  console.log("Fetching projects under group:", groupId)
  const url = `${gitLabBaseUrl}/groups/${encodeURIComponent(groupId)}/projects`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch repository: ${response.status} ${response.statusText}`
    );
  }
  return response.json();
};

const fetchRepositoryByReference = async (projectId, ref) => {
  const url = `${gitLabBaseUrl}/projects/${encodeURIComponent(
    projectId
  )}/repository/archive.tar.gz?sha=${encodeURIComponent(ref)}`;
  const headers = {
    "Private-Token": gitLabToken,
  };

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response;
};

const fetchAllProjectRecursive = async (groupId) => {
  let projects = [];

  const groupProjects = await fetchProjectsUnderGroup(groupId);
  projects = projects.concat(groupProjects);

  const subgroups = await fetchSubgroupByGroupId(groupId);
  for (const subgroup of subgroups) {
    const subgroupProjects = await fetchAllProjectRecursive(subgroup.id);
    projects = projects.concat(subgroupProjects);
  }

  return projects;
}

const searchInSourceCode = (header, fileStream, next, searchText) => {
  return new Promise((resolve, reject) => {
    let found = [];
    let foundNum = 0;
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    fileStream.on("end", () => {
      next();
      resolve(found);
    });
    fileStream.on("error", (error) => {
      console.error(chalk.bgRed("Error occurred: ", header.name, error?.message));
      reject(error?.message);
    });
    rl.on('close', () => {
      fileStream.resume()
    })
    rl.on("line", (line) => {
      searchText.forEach((oneSearchText) => {
        if (line.includes(oneSearchText)) {
          console.log(chalk.bgGreen("Found ", oneSearchText, " at: ", header.name));
          found.push({name: header.name, text: oneSearchText});
          foundNum++;
        }
      });
      if (foundNum === searchText.length) {
        rl.close();
      }
    });
  });
};

await (async () => {
  const [_, __, groupId, ref, ...searchText] = process.argv;

  if (!groupId || !ref || searchText.length === 0) {
    console.log("Usage: gitlab-repo-search <group_id> <ref> <search_text> <search_text>...");
    return;
  }

  let projects = [];
  try {
    projects = JSON.parse(await readFile('projects.json'));
    console.log("Using project list from file");
  } catch (error) {
    console.warn("Cannot read projects from file, begin fetching...", error);
  }
  if (!Array.isArray(projects) || projects.length === 0) {
    projects = await fetchAllProjectRecursive(groupId);
    await writeFile('projects.json', JSON.stringify(projects));
  }

  for (const project of projects) {
    const projectId = project.id;
    const gunzipStream = zlib.createGunzip();
    const tarExtractor = tar.extract();

    console.log(`Fetching repository '${projectId}' at reference '${ref}'...`);
    let archivedRepoResp;
    try {
      archivedRepoResp = await fetchRepositoryByReference(projectId, ref);
    } catch (error) {
      console.warn("Skipping", project.name_with_namespace, "because of", error.message);
      continue;
    }

    const searchPromises = [];
    let finishPromiseResolver;
    const finishPromise = new Promise((resolve, reject) => {
      finishPromiseResolver = resolve;
    });

    tarExtractor.on("entry", (header, stream, next) => {
      if (header?.type === "file") {
        printMemUsage();
        searchPromises.push(searchInSourceCode(header, stream, next, searchText));
      } else {
        stream.on('end', () => {
          next(); // simply next entry when not a file
        })
        stream.resume(); // just auto drain the stream
      }
    });

    tarExtractor.on("finish", () => {
      finishPromiseResolver();
      console.log("Done finding on ", projectId);
    });

    try {
      await pipeline(archivedRepoResp.body, gunzipStream, tarExtractor);
    } catch (e) {
      console.error(e);
    }

    await finishPromise
    const searchResults = await Promise.all(searchPromises);
    let foundOne = false;
    searchResults.forEach((fileResult) => {
      if (Array.isArray(fileResult) && fileResult.length > 0) {
        fileResult.forEach((oneResult) => {
          foundOne || console.log(chalk.bgWhite.black("Text found on", project.name_with_namespace, "with the following files:"));
          console.log(oneResult.name, oneResult.text);
          foundOne = true;
        })
      }
    });
    if (!foundOne) {
      console.log("Text not found on", project.name_with_namespace);
    }

    await setTimeout(15000); // avoid rate limit of getting project archive at 4 per minute
  }
})();
