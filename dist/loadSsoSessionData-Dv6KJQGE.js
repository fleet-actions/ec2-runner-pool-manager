import { P as ProviderError, I as IniSectionType, t as CONFIG_PREFIX_SEPARATOR, u as slurpFile, v as getConfigFilepath, w as parseIni } from './index.js';

class TokenProviderError extends ProviderError {
    constructor(message, options = true) {
        super(message, options);
        this.name = "TokenProviderError";
        Object.setPrototypeOf(this, TokenProviderError.prototype);
    }
}

const getSsoSessionData = (data) => Object.entries(data)
    .filter(([key]) => key.startsWith(IniSectionType.SSO_SESSION + CONFIG_PREFIX_SEPARATOR))
    .reduce((acc, [key, value]) => ({ ...acc, [key.substring(key.indexOf(CONFIG_PREFIX_SEPARATOR) + 1)]: value }), {});

const swallowError = () => ({});
const loadSsoSessionData = async (init = {}) => slurpFile(init.configFilepath ?? getConfigFilepath())
    .then(parseIni)
    .then(getSsoSessionData)
    .catch(swallowError);

export { TokenProviderError as T, loadSsoSessionData as l };
//# sourceMappingURL=loadSsoSessionData-Dv6KJQGE.js.map
