import { P as ProviderError, C as CredentialsProviderError, V as parseUrl, W as loadConfig } from './index.js';
import { parse } from 'url';
import { Buffer } from 'buffer';
import { request } from 'http';
import 'os';
import 'crypto';
import 'fs';
import 'path';
import 'https';
import 'net';
import 'tls';
import 'events';
import 'assert';
import 'util';
import 'stream';
import 'querystring';
import 'stream/web';
import 'node:stream';
import 'node:util';
import 'node:events';
import 'worker_threads';
import 'perf_hooks';
import 'util/types';
import 'async_hooks';
import 'console';
import 'zlib';
import 'string_decoder';
import 'diagnostics_channel';
import 'child_process';
import 'timers';
import 'http2';
import 'process';

function httpRequest(options) {
    return new Promise((resolve, reject) => {
        const req = request({
            method: "GET",
            ...options,
            hostname: options.hostname?.replace(/^\[(.+)\]$/, "$1"),
        });
        req.on("error", (err) => {
            reject(Object.assign(new ProviderError("Unable to connect to instance metadata service"), err));
            req.destroy();
        });
        req.on("timeout", () => {
            reject(new ProviderError("TimeoutError from instance metadata service"));
            req.destroy();
        });
        req.on("response", (res) => {
            const { statusCode = 400 } = res;
            if (statusCode < 200 || 300 <= statusCode) {
                reject(Object.assign(new ProviderError("Error response received from instance metadata service"), { statusCode }));
                req.destroy();
            }
            const chunks = [];
            res.on("data", (chunk) => {
                chunks.push(chunk);
            });
            res.on("end", () => {
                resolve(Buffer.concat(chunks));
                req.destroy();
            });
        });
        req.end();
    });
}

const isImdsCredentials = (arg) => Boolean(arg) &&
    typeof arg === "object" &&
    typeof arg.AccessKeyId === "string" &&
    typeof arg.SecretAccessKey === "string" &&
    typeof arg.Token === "string" &&
    typeof arg.Expiration === "string";
const fromImdsCredentials = (creds) => ({
    accessKeyId: creds.AccessKeyId,
    secretAccessKey: creds.SecretAccessKey,
    sessionToken: creds.Token,
    expiration: new Date(creds.Expiration),
    ...(creds.AccountId && { accountId: creds.AccountId }),
});

const DEFAULT_TIMEOUT = 1000;
const DEFAULT_MAX_RETRIES = 0;
const providerConfigFromInit = ({ maxRetries = DEFAULT_MAX_RETRIES, timeout = DEFAULT_TIMEOUT, }) => ({ maxRetries, timeout });

const retry = (toRetry, maxRetries) => {
    let promise = toRetry();
    for (let i = 0; i < maxRetries; i++) {
        promise = promise.catch(toRetry);
    }
    return promise;
};

const ENV_CMDS_FULL_URI = "AWS_CONTAINER_CREDENTIALS_FULL_URI";
const ENV_CMDS_RELATIVE_URI = "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI";
const ENV_CMDS_AUTH_TOKEN = "AWS_CONTAINER_AUTHORIZATION_TOKEN";
const fromContainerMetadata = (init = {}) => {
    const { timeout, maxRetries } = providerConfigFromInit(init);
    return () => retry(async () => {
        const requestOptions = await getCmdsUri({ logger: init.logger });
        const credsResponse = JSON.parse(await requestFromEcsImds(timeout, requestOptions));
        if (!isImdsCredentials(credsResponse)) {
            throw new CredentialsProviderError("Invalid response received from instance metadata service.", {
                logger: init.logger,
            });
        }
        return fromImdsCredentials(credsResponse);
    }, maxRetries);
};
const requestFromEcsImds = async (timeout, options) => {
    if (process.env[ENV_CMDS_AUTH_TOKEN]) {
        options.headers = {
            ...options.headers,
            Authorization: process.env[ENV_CMDS_AUTH_TOKEN],
        };
    }
    const buffer = await httpRequest({
        ...options,
        timeout,
    });
    return buffer.toString();
};
const CMDS_IP = "169.254.170.2";
const GREENGRASS_HOSTS = {
    localhost: true,
    "127.0.0.1": true,
};
const GREENGRASS_PROTOCOLS = {
    "http:": true,
    "https:": true,
};
const getCmdsUri = async ({ logger }) => {
    if (process.env[ENV_CMDS_RELATIVE_URI]) {
        return {
            hostname: CMDS_IP,
            path: process.env[ENV_CMDS_RELATIVE_URI],
        };
    }
    if (process.env[ENV_CMDS_FULL_URI]) {
        const parsed = parse(process.env[ENV_CMDS_FULL_URI]);
        if (!parsed.hostname || !(parsed.hostname in GREENGRASS_HOSTS)) {
            throw new CredentialsProviderError(`${parsed.hostname} is not a valid container metadata service hostname`, {
                tryNextLink: false,
                logger,
            });
        }
        if (!parsed.protocol || !(parsed.protocol in GREENGRASS_PROTOCOLS)) {
            throw new CredentialsProviderError(`${parsed.protocol} is not a valid container metadata service protocol`, {
                tryNextLink: false,
                logger,
            });
        }
        return {
            ...parsed,
            port: parsed.port ? parseInt(parsed.port, 10) : undefined,
        };
    }
    throw new CredentialsProviderError("The container metadata credential provider cannot be used unless" +
        ` the ${ENV_CMDS_RELATIVE_URI} or ${ENV_CMDS_FULL_URI} environment` +
        " variable is set", {
        tryNextLink: false,
        logger,
    });
};

class InstanceMetadataV1FallbackError extends CredentialsProviderError {
    constructor(message, tryNextLink = true) {
        super(message, tryNextLink);
        this.tryNextLink = tryNextLink;
        this.name = "InstanceMetadataV1FallbackError";
        Object.setPrototypeOf(this, InstanceMetadataV1FallbackError.prototype);
    }
}

var Endpoint;
(function (Endpoint) {
    Endpoint["IPv4"] = "http://169.254.169.254";
    Endpoint["IPv6"] = "http://[fd00:ec2::254]";
})(Endpoint || (Endpoint = {}));

const ENV_ENDPOINT_NAME = "AWS_EC2_METADATA_SERVICE_ENDPOINT";
const CONFIG_ENDPOINT_NAME = "ec2_metadata_service_endpoint";
const ENDPOINT_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => env[ENV_ENDPOINT_NAME],
    configFileSelector: (profile) => profile[CONFIG_ENDPOINT_NAME],
    default: undefined,
};

var EndpointMode;
(function (EndpointMode) {
    EndpointMode["IPv4"] = "IPv4";
    EndpointMode["IPv6"] = "IPv6";
})(EndpointMode || (EndpointMode = {}));

const ENV_ENDPOINT_MODE_NAME = "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE";
const CONFIG_ENDPOINT_MODE_NAME = "ec2_metadata_service_endpoint_mode";
const ENDPOINT_MODE_CONFIG_OPTIONS = {
    environmentVariableSelector: (env) => env[ENV_ENDPOINT_MODE_NAME],
    configFileSelector: (profile) => profile[CONFIG_ENDPOINT_MODE_NAME],
    default: EndpointMode.IPv4,
};

const getInstanceMetadataEndpoint = async () => parseUrl((await getFromEndpointConfig()) || (await getFromEndpointModeConfig()));
const getFromEndpointConfig = async () => loadConfig(ENDPOINT_CONFIG_OPTIONS)();
const getFromEndpointModeConfig = async () => {
    const endpointMode = await loadConfig(ENDPOINT_MODE_CONFIG_OPTIONS)();
    switch (endpointMode) {
        case EndpointMode.IPv4:
            return Endpoint.IPv4;
        case EndpointMode.IPv6:
            return Endpoint.IPv6;
        default:
            throw new Error(`Unsupported endpoint mode: ${endpointMode}.` + ` Select from ${Object.values(EndpointMode)}`);
    }
};

const STATIC_STABILITY_REFRESH_INTERVAL_SECONDS = 5 * 60;
const STATIC_STABILITY_REFRESH_INTERVAL_JITTER_WINDOW_SECONDS = 5 * 60;
const STATIC_STABILITY_DOC_URL = "https://docs.aws.amazon.com/sdkref/latest/guide/feature-static-credentials.html";
const getExtendedInstanceMetadataCredentials = (credentials, logger) => {
    const refreshInterval = STATIC_STABILITY_REFRESH_INTERVAL_SECONDS +
        Math.floor(Math.random() * STATIC_STABILITY_REFRESH_INTERVAL_JITTER_WINDOW_SECONDS);
    const newExpiration = new Date(Date.now() + refreshInterval * 1000);
    logger.warn("Attempting credential expiration extension due to a credential service availability issue. A refresh of these " +
        `credentials will be attempted after ${new Date(newExpiration)}.\nFor more information, please visit: ` +
        STATIC_STABILITY_DOC_URL);
    const originalExpiration = credentials.originalExpiration ?? credentials.expiration;
    return {
        ...credentials,
        ...(originalExpiration ? { originalExpiration } : {}),
        expiration: newExpiration,
    };
};

const staticStabilityProvider = (provider, options = {}) => {
    const logger = options?.logger || console;
    let pastCredentials;
    return async () => {
        let credentials;
        try {
            credentials = await provider();
            if (credentials.expiration && credentials.expiration.getTime() < Date.now()) {
                credentials = getExtendedInstanceMetadataCredentials(credentials, logger);
            }
        }
        catch (e) {
            if (pastCredentials) {
                logger.warn("Credential renew failed: ", e);
                credentials = getExtendedInstanceMetadataCredentials(pastCredentials, logger);
            }
            else {
                throw e;
            }
        }
        pastCredentials = credentials;
        return credentials;
    };
};

const IMDS_PATH = "/latest/meta-data/iam/security-credentials/";
const IMDS_TOKEN_PATH = "/latest/api/token";
const AWS_EC2_METADATA_V1_DISABLED = "AWS_EC2_METADATA_V1_DISABLED";
const PROFILE_AWS_EC2_METADATA_V1_DISABLED = "ec2_metadata_v1_disabled";
const X_AWS_EC2_METADATA_TOKEN = "x-aws-ec2-metadata-token";
const fromInstanceMetadata = (init = {}) => staticStabilityProvider(getInstanceMetadataProvider(init), { logger: init.logger });
const getInstanceMetadataProvider = (init = {}) => {
    let disableFetchToken = false;
    const { logger, profile } = init;
    const { timeout, maxRetries } = providerConfigFromInit(init);
    const getCredentials = async (maxRetries, options) => {
        const isImdsV1Fallback = disableFetchToken || options.headers?.[X_AWS_EC2_METADATA_TOKEN] == null;
        if (isImdsV1Fallback) {
            let fallbackBlockedFromProfile = false;
            let fallbackBlockedFromProcessEnv = false;
            const configValue = await loadConfig({
                environmentVariableSelector: (env) => {
                    const envValue = env[AWS_EC2_METADATA_V1_DISABLED];
                    fallbackBlockedFromProcessEnv = !!envValue && envValue !== "false";
                    if (envValue === undefined) {
                        throw new CredentialsProviderError(`${AWS_EC2_METADATA_V1_DISABLED} not set in env, checking config file next.`, { logger: init.logger });
                    }
                    return fallbackBlockedFromProcessEnv;
                },
                configFileSelector: (profile) => {
                    const profileValue = profile[PROFILE_AWS_EC2_METADATA_V1_DISABLED];
                    fallbackBlockedFromProfile = !!profileValue && profileValue !== "false";
                    return fallbackBlockedFromProfile;
                },
                default: false,
            }, {
                profile,
            })();
            if (init.ec2MetadataV1Disabled || configValue) {
                const causes = [];
                if (init.ec2MetadataV1Disabled)
                    causes.push("credential provider initialization (runtime option ec2MetadataV1Disabled)");
                if (fallbackBlockedFromProfile)
                    causes.push(`config file profile (${PROFILE_AWS_EC2_METADATA_V1_DISABLED})`);
                if (fallbackBlockedFromProcessEnv)
                    causes.push(`process environment variable (${AWS_EC2_METADATA_V1_DISABLED})`);
                throw new InstanceMetadataV1FallbackError(`AWS EC2 Metadata v1 fallback has been blocked by AWS SDK configuration in the following: [${causes.join(", ")}].`);
            }
        }
        const imdsProfile = (await retry(async () => {
            let profile;
            try {
                profile = await getProfile(options);
            }
            catch (err) {
                if (err.statusCode === 401) {
                    disableFetchToken = false;
                }
                throw err;
            }
            return profile;
        }, maxRetries)).trim();
        return retry(async () => {
            let creds;
            try {
                creds = await getCredentialsFromProfile(imdsProfile, options, init);
            }
            catch (err) {
                if (err.statusCode === 401) {
                    disableFetchToken = false;
                }
                throw err;
            }
            return creds;
        }, maxRetries);
    };
    return async () => {
        const endpoint = await getInstanceMetadataEndpoint();
        if (disableFetchToken) {
            logger?.debug("AWS SDK Instance Metadata", "using v1 fallback (no token fetch)");
            return getCredentials(maxRetries, { ...endpoint, timeout });
        }
        else {
            let token;
            try {
                token = (await getMetadataToken({ ...endpoint, timeout })).toString();
            }
            catch (error) {
                if (error?.statusCode === 400) {
                    throw Object.assign(error, {
                        message: "EC2 Metadata token request returned error",
                    });
                }
                else if (error.message === "TimeoutError" || [403, 404, 405].includes(error.statusCode)) {
                    disableFetchToken = true;
                }
                logger?.debug("AWS SDK Instance Metadata", "using v1 fallback (initial)");
                return getCredentials(maxRetries, { ...endpoint, timeout });
            }
            return getCredentials(maxRetries, {
                ...endpoint,
                headers: {
                    [X_AWS_EC2_METADATA_TOKEN]: token,
                },
                timeout,
            });
        }
    };
};
const getMetadataToken = async (options) => httpRequest({
    ...options,
    path: IMDS_TOKEN_PATH,
    method: "PUT",
    headers: {
        "x-aws-ec2-metadata-token-ttl-seconds": "21600",
    },
});
const getProfile = async (options) => (await httpRequest({ ...options, path: IMDS_PATH })).toString();
const getCredentialsFromProfile = async (profile, options, init) => {
    const credentialsResponse = JSON.parse((await httpRequest({
        ...options,
        path: IMDS_PATH + profile,
    })).toString());
    if (!isImdsCredentials(credentialsResponse)) {
        throw new CredentialsProviderError("Invalid response received from instance metadata service.", {
            logger: init.logger,
        });
    }
    return fromImdsCredentials(credentialsResponse);
};

export { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT, ENV_CMDS_AUTH_TOKEN, ENV_CMDS_FULL_URI, ENV_CMDS_RELATIVE_URI, Endpoint, fromContainerMetadata, fromInstanceMetadata, getInstanceMetadataEndpoint, httpRequest, providerConfigFromInit };
//# sourceMappingURL=index-C_mVSzsD.js.map
