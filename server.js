/*jshint node:true, esversion: 6 */
'use strict';

var bodyParser  	= require('body-parser');
var jose 			= require('node-jose');
var keystore 		= jose.JWK.createKeyStore();
var Buffer 			= require('buffer').Buffer;
var app 			= require('express')();
var jwt 			= require('jsonwebtoken');
var svgCaptcha 		= require('svg-captcha');
var algorithm 		= 'aes-256-ctr';
var SECRET 			= process.env.SECRET || "defaultSecret";
var SALT 			= process.env.SALT || "defaultSalt";
var PRIVATE_KEY 	= process.env.PRIVATE_KEY || { kty: 'oct', kid: 'gBdaS-G8RLax2qObTD94w', use: 'enc', alg: 'A256GCM', k: 'FK3d8WvSRdxlUHs4Fs_xxYO3-6dCiUarBwiYNFw5hv8' };
var LOG_LEVEL		= process.env.LOG_LEVEL || "error";
var SERVICE_PORT 	= process.env.SERVICE_PORT || 3000;

////////////////////////////////////////////////////////
/*
 * Logger
 */
////////////////////////////////////////////////////////
function logger(obj, level) {
	if (LOG_LEVEL === "none") {
		return;
	} else if (level === "error" && (LOG_LEVEL === "error" || LOG_LEVEL === "debug")) {
		console.error(new Error(obj));
	} else if (level === "debug" && LOG_LEVEL === "debug") {
		console.log(obj);
	}
}

////////////////////////////////////////////////////////
/*
 * App Startup
 */
////////////////////////////////////////////////////////
app.use(bodyParser.json());
// app.use(function(req, res, next) {
// 	res.header("Access-Control-Allow-Origin", "*");
// 	res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
// 	next();
// });

var args = process.argv;
if (args.length == 3 && args[2] == 'server') {
	var server = app.listen(SERVICE_PORT, 'localhost', function () {
		var host = server.address().address;
		var port = server.address().port;
		console.warn(`MyGov Captcha Service listening at http://${host}:${port}`);
		console.warn(`Log level is at: ${LOG_LEVEL}`);
	});
	}

////////////////////////////////////////////////////////
/*
 * Encryption Routines
 */
////////////////////////////////////////////////////////
function decrypt(password, private_key) {
	return new Promise(function (resolve, reject) {
		logger(`decrypt: ${password}`, "debug");
		try {
			jose.JWK.asKey(private_key, "json")
			.then(function (res) {
				jose.JWE.createDecrypt(res)
				.decrypt(password)
				.then(function (decrypted) {
					logger(`decrypt: ${decrypted.plaintext.toString('utf8')}`, "debug");
					resolve(decrypted.plaintext.toString('utf8'));
				});
			});
		} catch (e) {
			logger(`err: ${e}`, "error");
		}
	});
}
function encrypt(password, private_key) {
	logger(`encrypt: ${password}`, "debug");
	return new Promise(function (resolve, reject) {
		var buff = Buffer.from(password, 'utf8');
		try {
			jose.JWE.createEncrypt(PRIVATE_KEY)
			.update(buff)
			.final()
			.then(function (cr) {
				logger(`encrypted: ${cr}`, "debug");
				resolve(cr);
			});
		} catch (e) {
			logger(`err: ${e}`, "error");
		}
	});
}

////////////////////////////////////////////////////////
/*
 * Get a new captcha
 */
////////////////////////////////////////////////////////
var getCaptcha = function (payload) {
	logger(`getCaptcha: ${payload.nonce}`, "debug");
	var captcha = svgCaptcha.create();
	if (!captcha || (captcha && !captcha.data)) {
		// Something bad happened with Captcha.
		return {valid: false};
	}
	logger(`captcha generated: ${captcha.text}`, "debug");

	return encrypt(payload.nonce, PRIVATE_KEY)
	.then(function (validation) {
		if (validation === "") {
			// Error
			logger(`Validation Failed`, "error");
			return {valid: false};
		} else {
			logger(`validation: ${validation}`, "debug");
			return {nonce: payload.nonce, captcha: captcha.data, validation: validation};
		}
	});
};
exports.getCaptcha = getCaptcha;

app.post('/captcha', function (req, res) {
	getCaptcha(req.body)
	.then(function (captcha) {
		logger(`returning: ${captcha}`, "debug");
		return res.send(captcha);
	});
});


////////////////////////////////////////////////////////
/*
 * Verify a captcha against it's encrypted response.
 * If successful, return a signed jwt by us.
 */
////////////////////////////////////////////////////////
var verifyCaptcha = function (payload) {
	logger(`incoming payload: ${payload}`, "debug");
	var validation = payload.validation;
	var answer = payload.answer;
	var nonce = payload.nonce;
	logger(`validation: ${validation}`, "debug");
	logger(`answer: ${answer}`, "debug");

	return decrypt(validation, PRIVATE_KEY)
	.then(function (obj) {
		logger(`verifyCaptcha decrypted: ${obj}`, "debug");
		if (obj === nonce) {
			// Passed the captcha test
			logger(`Captcha verified! Creating JWT.`, "debug");

			var token = jwt.sign({nonce: nonce}, SECRET);
			return { valid: true, jwt: token };
		} else {
			logger(`Captcha answer invalid!`, "error");
			return {valid: false};
		}
	});
};
exports.verifyCaptcha = verifyCaptcha;

app.post('/verify/captcha', function (req, res) {
	verifyCaptcha(req.body)
	.then(function (ret) {
		return res.send(ret);
	});
});


////////////////////////////////////////////////////////
/*
 * Verify a JWT generated by us.
 */
////////////////////////////////////////////////////////
var verifyJWT = function (token, nonce) {
	try {
		logger(`verifying: ${token} against ${nonce}`, "debug");

		var decoded = jwt.verify(token, SECRET);
		logger(`decoded: ${decoded}`, "debug");

		if (decoded.nonce === nonce) {
			logger(`Captcha Valid`, "debug");
			return {valid: true};
		} else {
			logger(`Captcha Invalid!`, "debug");
			return {valid: false};
		}
	} catch (e) {
		logger(`Token/ResourceID Verification Failed: ${e}`, "error");
		return {valid: false};
	}
};
exports.verifyJWT = verifyJWT;

app.post('/verify/jwt', function (req, res) {
	res.send(verifyJWT(req.body.token, req.body.nonce));
});
