#!/usr/bin/env node

import { pipeline } from 'node:stream/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import fetch from 'node-fetch';
import tar from 'tar-stream';
import zlib from 'zlib';
import readline from 'readline';
import prompt from 'password-prompt';
import { program } from 'commander';
import { logger, resultLogger } from './logger.js';
import { URLSearchParams } from 'node:url';

const gitLabBaseUrl = 'https://gitlab.com/api/v4';
let gitLabToken;
const itemsPerPage = 50;

const repos = [];

const getHeaders = () => {
  return {
    'Private-Token': gitLabToken,
  };
};

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

  logger.debug(JSON.stringify(memoryUsage, null, 2));
};

const fetchSubgroupByGroupId = async (groupId, page) => {
  const param = new URLSearchParams({
    page: page || 1,
    per_page: itemsPerPage,
  });
  const url = `${gitLabBaseUrl}/groups/${encodeURIComponent(
    groupId
  )}/subgroups?${param.toString()}`;
  const headers = getHeaders();
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch subgroup: ${response.status} ${response.statusText}`
    );
  }

  let nextPageResponse = [];
  const nextPage = response.headers?.get('x-next-page');
  if (nextPage) {
    nextPageResponse = await fetchSubgroupByGroupId(groupId, nextPage);
  }

  const respJson = await response.json();
  return respJson.concat(nextPageResponse);
};

const fetchProjectsUnderGroup = async (groupId, page) => {
  logger.verbose('Fetching projects under group: %s', groupId);
  const param = new URLSearchParams({
    page: page || 1,
    per_page: itemsPerPage,
  });
  const url = `${gitLabBaseUrl}/groups/${encodeURIComponent(
    groupId
  )}/projects?${param.toString()}`;
  const headers = getHeaders();

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch repository: ${response.status} ${response.statusText}`
    );
  }

  let nextPageResponse = [];
  const nextPage = response.headers?.get('x-next-page');
  if (nextPage) {
    nextPageResponse = await fetchProjectsUnderGroup(groupId, nextPage);
  }

  const respJson = await response.json();
  return respJson.concat(nextPageResponse);
};

const fetchRepositoryByReference = async (projectId, ref) => {
  const url = `${gitLabBaseUrl}/projects/${encodeURIComponent(
    projectId
  )}/repository/archive.tar.gz?sha=${encodeURIComponent(ref)}`;
  const headers = getHeaders();

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
};

const searchInSourceCode = (header, fileStream, next, searchText) => {
  return new Promise((resolve, reject) => {
    let found = [];
    let foundNum = 0;
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    fileStream.on('end', () => {
      next();
      resolve(found);
    });
    fileStream.on('error', (error) => {
      logger.error('Error occurred: %s %s', header.name, error?.message);
      reject(error?.message);
    });
    rl.on('close', () => {
      fileStream.resume();
    });
    rl.on('line', (line) => {
      searchText.forEach((oneSearchText) => {
        if (line.includes(oneSearchText)) {
          logger.verbose('Found %s at: %s', oneSearchText, header.name);
          found.push({ name: header.name, text: oneSearchText });
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
  program
    .usage('[options] -- <search text...>')
    .requiredOption('--group-id <group>', "Gitlab's group ID")
    .option(
      '--ref <ref...>',
      'Git referece, could be multiple values, would use next ref when not found on repo, default to main',
      ['main']
    )
    .option('--access-token <token>', 'Personal access token');

  program.parse();
  const options = program.opts();
  const searchText = program.args;

  gitLabToken = options.accessToken;
  if (!gitLabToken) {
    gitLabToken = await prompt('Access token: ');
  }

  let projects = [];
  try {
    projects = JSON.parse(await readFile('projects.json'));
    logger.debug('Using project list from file');
  } catch (error) {
    logger.warn('Cannot read projects from file, begin fetching... %s', error);
  }
  if (!Array.isArray(projects) || projects.length === 0) {
    projects = await fetchAllProjectRecursive(options.groupId);
    await writeFile('projects.json', JSON.stringify(projects));
  }

  for (const project of projects) {
    const projectId = project.id;
    const gunzipStream = zlib.createGunzip();
    const tarExtractor = tar.extract();

    let found = false;
    let archivedRepoResp;
    for (const ref of options.ref) {
      logger.verbose(
        "Fetching repository '%s' at reference '%s'...",
        projectId,
        ref
      );
      try {
        archivedRepoResp = await fetchRepositoryByReference(projectId, ref);
        found = true;
      } catch (error) {
        logger.warn(
          'Skipping %s because of %s',
          project.name_with_namespace,
          error.message
        );
      }
      if (found) {
        break;
      }
      await setTimeout(15000); // avoid rate limit of getting project archive at 4 per minute
    }
    if (!found) {
      continue;
    }

    const searchPromises = [];
    let finishPromiseResolver;
    const finishPromise = new Promise((resolve, reject) => {
      finishPromiseResolver = resolve;
    });

    tarExtractor.on('entry', (header, stream, next) => {
      if (header?.type === 'file') {
        printMemUsage();
        searchPromises.push(
          searchInSourceCode(header, stream, next, searchText)
        );
      } else {
        stream.on('end', () => {
          next(); // simply next entry when not a file
        });
        stream.resume(); // just auto drain the stream
      }
    });

    tarExtractor.on('finish', () => {
      finishPromiseResolver();
      logger.verbose('Done finding on %s', projectId);
    });

    try {
      await pipeline(archivedRepoResp.body, gunzipStream, tarExtractor);
    } catch (e) {
      logger.error(e);
    }

    await finishPromise;
    const searchResults = await Promise.all(searchPromises);
    let foundOne = false;
    searchResults.forEach((fileResult) => {
      if (Array.isArray(fileResult) && fileResult.length > 0) {
        fileResult.forEach((oneResult) => {
          foundOne ||
            resultLogger.info(
              'Text found on %s with the following files:',
              project.name_with_namespace
            );
          resultLogger.info('%s - %s', oneResult.name, oneResult.text);
          foundOne = true;
        });
      }
    });
    if (!foundOne) {
      resultLogger.info('Text not found on %s', project.name_with_namespace);
    }

    await setTimeout(15000); // avoid rate limit of getting project archive at 4 per minute
  }
})();
