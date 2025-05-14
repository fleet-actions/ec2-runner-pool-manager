function extendedEncodeURIComponent(str) {
    return encodeURIComponent(str).replace(/[!'()*]/g, function (c) {
        return "%" + c.charCodeAt(0).toString(16).toUpperCase();
    });
}

class NoAuthSigner {
    async sign(httpRequest, identity, signingProperties) {
        return httpRequest;
    }
}

const SENSITIVE_STRING = "***SensitiveInformation***";

export { NoAuthSigner as N, SENSITIVE_STRING as S, extendedEncodeURIComponent as e };
//# sourceMappingURL=constants-Cemwouaq.js.map
