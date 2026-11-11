"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureGeoidReady = ensureGeoidReady;
exports.isGeoidReady = isGeoidReady;
exports.geoidHeightOrZero = geoidHeightOrZero;
let egm96MeanSeaLevel = null;
let readyPromise = null;
/**
 * Lazily loads the EGM96 15' geoid grid (~2.7 MB) so it stays out of the eager
 * client bundle while giving sea-level layers accurate ellipsoidal height (h = H + N).
 */
function ensureGeoidReady(onReady) {
    if (egm96MeanSeaLevel) {
        onReady?.();
        return Promise.resolve();
    }
    if (!readyPromise) {
        readyPromise = Promise.resolve().then(() => __importStar(require('egm96-universal'))).then((mod) => {
            egm96MeanSeaLevel = mod.meanSeaLevel;
        })
            .catch(() => {
            readyPromise = null;
        });
    }
    if (onReady) {
        return readyPromise.then(() => {
            if (egm96MeanSeaLevel)
                onReady();
        });
    }
    return readyPromise;
}
function isGeoidReady() {
    return egm96MeanSeaLevel !== null;
}
/**
 * Local EGM96 geoid undulation N in metres relative to the WGS84 ellipsoid
 * (roughly -106..+85 m worldwide), or 0 while the grid is still loading.
 */
function geoidHeightOrZero(latDeg, lonDeg) {
    if (!egm96MeanSeaLevel || !Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) {
        return 0;
    }
    const n = egm96MeanSeaLevel(latDeg, lonDeg);
    return Number.isFinite(n) ? n : 0;
}
