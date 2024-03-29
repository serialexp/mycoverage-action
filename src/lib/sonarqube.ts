import axios from "axios";
import https from "https";
import crypto from "crypto";

export type Severity = "LOW" | "MEDIUM" | "HIGH";
export type AnnotationType = "CODE_SMELL" | "BUG" | "VULNERABILITY";

export interface SonarqubeIssue {
  key: string;
  rule: string;
  severity: "INFO" | "MINOR" | "MAJOR" | "CRITICAL" | "BLOCKER";
  component: string;
  project: string;
  line: string;
  hash: string;
  textRange?: {
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
  };
  flows: string[];
  status: "OPEN" | "CLOSED";
  message: string;
  effort: string;
  debt: string;
  author: string;
  tags: string[];
  creationDate: string;
  updateDate: string;
  type: "CODE_SMELL" | "VULNERABILITY" | "BUG" | "";
  organization: string;
  scope: string;
  path: string;
}

export class Sonarqube {
  endpoint: string;
  login: string;
  password: string;
  projectName: string;
  repoName: string;
  commitId: string;

  private instance;

  constructor(
    endpoint: string,
    login: string,
    password: string,
    projectName: string,
    repoName: string,
    commitId: string
  ) {
    this.endpoint = endpoint;
    this.login = login;
    this.password = password;

    this.projectName = projectName;
    this.repoName = repoName;
    this.commitId = commitId;

    this.instance = axios.create({
      httpsAgent: new https.Agent({
        rejectUnauthorized: false,
      }),
    });
  }

  request(method: string, action: string, data: unknown = {}) {
    console.log(`[${method}] ${this.endpoint}${action}`);
    return this.instance.request({
      method,
      url: this.endpoint + action,
      data,
      auth: {
        username: this.login,
        password: this.password,
      },
    });
  }

  async getTasks() {
    const result = await this.request("GET", "api/ce/activity");
    return result.data.tasks;
  }

  async getReports() {
    return (await this.getTasks()).filter((task: any) => task.type === 'REPORT');
  }

  async getFinishedReports() {
    return (await this.getTasks()).filter((task: any) => task.status === 'SUCCESS' && task.type === 'REPORT');
  }

  async waitForReportToShowUp(timeout = 60000) {
    let timeoutTimeout = setTimeout(() => {
        throw new Error("Timeout waiting for report to show up");
    }, timeout);
    let runningTasks = await this.getReports()
    if (runningTasks.length === 0) {
      console.log(`No reports yet.`)
    }
    while (runningTasks.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      runningTasks = await this.getReports();
      if (runningTasks.length === 0) {
        console.log(`No reports yet.`)
        const tasks = await this.getTasks();
        console.log(`Tasks: ${tasks.map((t: any) => t.type).join(', ')}`)
      }
    }
    console.log("Reports showed up")
    clearTimeout(timeoutTimeout);
  }

  async waitForReportsToFinish(timeout = 60000) {
    let timeoutTimeout = setTimeout(() => {
        throw new Error("Timeout waiting for tasks to finish");
    }, timeout);
    let finishedTasks = await this.getFinishedReports()
    if (finishedTasks.length === 0) {
      console.log(`Reports for analyses ${finishedTasks.map((t: any) => t.analysisId).join(', ')} still running.`)
    }
    while (finishedTasks.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      finishedTasks = await this.getFinishedReports();
      if (finishedTasks.length === 0) {
        console.log(`Reports for analyses ${finishedTasks.map((t: any) => t.analysisId).join(', ')} still running.`)
      }
    }
    console.log("Reports finished")
    clearTimeout(timeoutTimeout);
  }

  async getIssues() {
    const issues: SonarqubeIssue[] = [];
    const componentToFile: Record<string, string> = {};

    const pushIssues = (originalIssues: SonarqubeIssue[]) => {
      for (const issue of originalIssues) {
        if (componentToFile[issue.component] === undefined) {
          throw new Error(`Cannot map component ${issue.component} to file!`);
        }
        const newHash = crypto
          .createHash("md5")
          .update(
            issue.component +
              issue.hash +
              issue.rule +
              (issue.textRange
                ? issue.textRange.startLine +
                  issue.textRange.endLine +
                  issue.textRange.startOffset +
                  issue.textRange.endOffset
                : issue.line)
          )
          .digest("hex");

        const issueToAdd = {
          ...issue,
          path: componentToFile[issue.component] ?? "",
          hash: newHash,
        };

        const existingIssue = issues.find((i) => i.hash === newHash);
        if (existingIssue) {
          // if you see this error look at it carefully, chances are we do not calculate the hash accurately
          console.log("Issue with same hash already exists", {
            issueToAdd,
            existingIssue,
          });
          return;
        }

        issues.push(issueToAdd);
      }
    };

    await Promise.all(
      ["INFO", "MINOR", "MAJOR", "CRITICAL", "BLOCKER"].map(
        async (severity) => {
          let pageNumber = 1;
          let result = await this.request(
            "GET",
            `api/issues/search?p=${pageNumber}&severities=${severity}&ps=500&resolved=false`
          );
          for (const comp of result.data.components) {
            componentToFile[comp.key] = comp.path;
          }
          pushIssues(result.data.issues);

          while (result.data.issues.length >= 500) {
            pageNumber++;
            result = await this.request(
              "GET",
              `api/issues/search?p=${pageNumber}&severities=${severity}&ps=500&resolved=false`
            );
            for (const comp of result.data.components) {
              componentToFile[comp.key] = comp.path;
            }
            pushIssues(result.data.issues);
          }
        }
      )
    );

    console.log(`Total issues ${issues.length}`);

    return issues;
  }
}
