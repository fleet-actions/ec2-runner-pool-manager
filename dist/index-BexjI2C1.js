import { C as CredentialsProviderError, H as HttpRequest, J as parseRfc3339DateTime, N as NodeHttpHandler, w as setCredentialFeature } from './index.js';
import 'http2';
import 'stream';
import fs from 'fs/promises';
import 'buffer';
import 'node:stream';
import { s as sdkStreamMixin } from './sdk-stream-mixin-tnzn7_YV.js';
import 'os';
import 'crypto';
import 'fs';
import 'path';
import 'http';
import 'https';
import 'net';
import 'tls';
import 'events';
import 'assert';
import 'util';
import 'querystring';
import 'stream/web';
import 'node:util';
import 'node:events';
import 'worker_threads';
import 'perf_hooks';
import 'util/types';
import 'async_hooks';
import 'console';
import 'url';
import 'zlib';
import 'string_decoder';
import 'diagnostics_channel';
import 'child_process';
import 'timers';
import 'process';

const ECS_CONTAINER_HOST = "169.254.170.2";
const EKS_CONTAINER_HOST_IPv4 = "169.254.170.23";
const EKS_CONTAINER_HOST_IPv6 = "[fd00:ec2::23]";
const checkUrl = (url, logger) => {
    if (url.protocol === "https:") {
        return;
    }
    if (url.hostname === ECS_CONTAINER_HOST ||
        url.hostname === EKS_CONTAINER_HOST_IPv4 ||
        url.hostname === EKS_CONTAINER_HOST_IPv6) {
        return;
    }
    if (url.hostname.includes("[")) {
        if (url.hostname === "[::1]" || url.hostname === "[0000:0000:0000:0000:0000:0000:0000:0001]") {
            return;
        }
    }
    else {
        if (url.hostname === "localhost") {
            return;
        }
        const ipComponents = url.hostname.split(".");
        const inRange = (component) => {
            const num = parseInt(component, 10);
            return 0 <= num && num <= 255;
        };
        if (ipComponents[0] === "127" &&
            inRange(ipComponents[1]) &&
            inRange(ipComponents[2]) &&
            inRange(ipComponents[3]) &&
            ipComponents.length === 4) {
            return;
        }
    }
    throw new CredentialsProviderError(`URL not accepted. It must either be HTTPS or match one of the following:
  - loopback CIDR 127.0.0.0/8 or [::1/128]
  - ECS container host 169.254.170.2
  - EKS container host 169.254.170.23 or [fd00:ec2::23]`, { logger });
};

function createGetRequest(url) {
    return new HttpRequest({
        protocol: url.protocol,
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        query: Array.from(url.searchParams.entries()).reduce((acc, [k, v]) => {
            acc[k] = v;
            return acc;
        }, {}),
        fragment: url.hash,
    });
}
async function getCredentials(response, logger) {
    const stream = sdkStreamMixin(response.body);
    const str = await stream.transformToString();
    if (response.statusCode === 200) {
        const parsed = JSON.parse(str);
        if (typeof parsed.AccessKeyId !== "string" ||
            typeof parsed.SecretAccessKey !== "string" ||
            typeof parsed.Token !== "string" ||
            typeof parsed.Expiration !== "string") {
            throw new CredentialsProviderError("HTTP credential provider response not of the required format, an object matching: " +
                "{ AccessKeyId: string, SecretAccessKey: string, Token: string, Expiration: string(rfc3339) }", { logger });
        }
        return {
            accessKeyId: parsed.AccessKeyId,
            secretAccessKey: parsed.SecretAccessKey,
            sessionToken: parsed.Token,
            expiration: parseRfc3339DateTime(parsed.Expiration),
        };
    }
    if (response.statusCode >= 400 && response.statusCode < 500) {
        let parsedBody = {};
        try {
            parsedBody = JSON.parse(str);
        }
        catch (e) { }
        throw Object.assign(new CredentialsProviderError(`Server responded with status: ${response.statusCode}`, { logger }), {
            Code: parsedBody.Code,
            Message: parsedBody.Message,
        });
    }
    throw new CredentialsProviderError(`Server responded with status: ${response.statusCode}`, { logger });
}

const retryWrapper = (toRetry, maxRetries, delayMs) => {
    return async () => {
        for (let i = 0; i < maxRetries; ++i) {
            try {
                return await toRetry();
            }
            catch (e) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
        return await toRetry();
    };
};

const AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI";
const DEFAULT_LINK_LOCAL_HOST = "http://169.254.170.2";
const AWS_CONTAINER_CREDENTIALS_FULL_URI = "AWS_CONTAINER_CREDENTIALS_FULL_URI";
const AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE = "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE";
const AWS_CONTAINER_AUTHORIZATION_TOKEN = "AWS_CONTAINER_AUTHORIZATION_TOKEN";
const fromHttp = (options = {}) => {
    options.logger?.debug("@aws-sdk/credential-provider-http - fromHttp");
    let host;
    const relative = options.awsContainerCredentialsRelativeUri ?? process.env[AWS_CONTAINER_CREDENTIALS_RELATIVE_URI];
    const full = options.awsContainerCredentialsFullUri ?? process.env[AWS_CONTAINER_CREDENTIALS_FULL_URI];
    const token = options.awsContainerAuthorizationToken ?? process.env[AWS_CONTAINER_AUTHORIZATION_TOKEN];
    const tokenFile = options.awsContainerAuthorizationTokenFile ?? process.env[AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE];
    const warn = options.logger?.constructor?.name === "NoOpLogger" || !options.logger ? console.warn : options.logger.warn;
    if (relative && full) {
        warn("@aws-sdk/credential-provider-http: " +
            "you have set both awsContainerCredentialsRelativeUri and awsContainerCredentialsFullUri.");
        warn("awsContainerCredentialsFullUri will take precedence.");
    }
    if (token && tokenFile) {
        warn("@aws-sdk/credential-provider-http: " +
            "you have set both awsContainerAuthorizationToken and awsContainerAuthorizationTokenFile.");
        warn("awsContainerAuthorizationToken will take precedence.");
    }
    if (full) {
        host = full;
    }
    else if (relative) {
        host = `${DEFAULT_LINK_LOCAL_HOST}${relative}`;
    }
    else {
        throw new CredentialsProviderError(`No HTTP credential provider host provided.
Set AWS_CONTAINER_CREDENTIALS_FULL_URI or AWS_CONTAINER_CREDENTIALS_RELATIVE_URI.`, { logger: options.logger });
    }
    const url = new URL(host);
    checkUrl(url, options.logger);
    const requestHandler = new NodeHttpHandler({
        requestTimeout: options.timeout ?? 1000,
        connectionTimeout: options.timeout ?? 1000,
    });
    return retryWrapper(async () => {
        const request = createGetRequest(url);
        if (token) {
            request.headers.Authorization = token;
        }
        else if (tokenFile) {
            request.headers.Authorization = (await fs.readFile(tokenFile)).toString();
        }
        try {
            const result = await requestHandler.handle(request);
            return getCredentials(result.response).then((creds) => setCredentialFeature(creds, "CREDENTIALS_HTTP", "z"));
        }
        catch (e) {
            throw new CredentialsProviderError(String(e), { logger: options.logger });
        }
    }, options.maxRetries ?? 3, options.timeout ?? 1000);
};

export { fromHttp };
//# sourceMappingURL=index-BexjI2C1.js.map
