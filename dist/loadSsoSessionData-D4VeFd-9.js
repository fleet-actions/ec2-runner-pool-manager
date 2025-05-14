import { P as ProviderError, I as IniSectionType, B as CONFIG_PREFIX_SEPARATOR, D as slurpFile, F as getConfigFilepath, G as parseIni } from './index.js';

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
//# sourceMappingURL=loadSsoSessionData-D4VeFd-9.js.map
