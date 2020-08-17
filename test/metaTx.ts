import { assert, expect } from 'chai';
import { ethers, ethereum } from "@nomiclabs/buidler";
import { Signer, utils } from "ethers";
const Decimal = require('decimal.js');
const { calcOutGivenIn, calcInGivenOut, calcRelativeDiff } = require('./lib/calc_comparisons');
const errorDelta = 10 ** -8;
const verbose = process.env.VERBOSE;
const ethUtil = require('ethereumjs-util');
const abi = require('ethereumjs-abi');

// Recursively finds all the dependencies of a type
function dependencies(types, primaryType, found: any[] = []) {
    if (found.includes(primaryType)) {
        return found;
    }
    if (types[primaryType] === undefined) {
        return found;
    }
    found.push(primaryType);
    for (let field of types[primaryType]) {
        for (let dep of dependencies(field.type, found)) {
            if (!found.includes(dep)) {
                found.push(dep);
            }
        }
    }
    return found;
}

function encodeType(types, primaryType) {
    // Get dependencies primary first, then alphabetical
    let deps = dependencies(types, primaryType);
    deps = deps.filter(t => t != primaryType);
    deps = [primaryType].concat(deps.sort());

    // Format as a string with fields
    let result = '';
    for (let type of deps) {
        result += `${type}(${types[type].map(({ name, type }) => `${type} ${name}`).join(',')})`;
    }
    return result;
}

function encodeData(types, primaryType, data) {
    let encTypes: any[] = [];
    let encValues: any[] = [];

    // Add typehash
    encTypes.push('bytes32');
    encValues.push(ethUtil.keccak256(encodeType(types, primaryType)));

    // Add field contents
    for (let field of types[primaryType]) {
        let value = data[field.name];
        if (field.type == 'string' || field.type == 'bytes') {
            encTypes.push('bytes32');
            value = ethUtil.keccak256(value);
            encValues.push(value);
        } else if (types[field.type] !== undefined) {
            console.log('??? YEAH')
            encTypes.push('bytes32');
            value = ethUtil.keccak256(encodeData(field.type, value, {}));
            encValues.push(value);
        } else if (field.type.lastIndexOf(']') === field.type.length - 1) {
            throw 'TODO: Arrays currently unimplemented in encodeData';
        } else {
            encTypes.push(field.type);
            encValues.push(value);
        }
    }

    return abi.rawEncode(encTypes, encValues);
}

function structHash(types, primaryType, data) {
    return ethUtil.keccak256(encodeData(types, primaryType, data));
}

describe('ExchangeProxy metaTx', async () => {
        const toWei = utils.parseEther;
        const fromWei = utils.formatEther;
        const MAX = ethers.constants.MaxUint256;

        let factory: any;
        let proxy: any;
        let PROXY: string;
        let pool1: any;
        let pool2: any;
        let pool3: any;
        let POOL1: any;
        let POOL2: any;
        let POOL3: any;
        let weth: any;
        let dai: any;
        let mkr: any;
        let WETH: string;
        let DAI: string;
        let MKR: string;
        let ETH: string;
        let relayerSigner: any;
        let userSigner: any;
        let balancerSigner: any;
        let userPk: any;
        let relayer: string;
        let user: string;
        let balancer: string;
        let gasPrice = 30000000000;

        before(async () => {
            [relayerSigner, userSigner, balancerSigner] = await ethers.getSigners();
            relayer = await relayerSigner.getAddress();
            user = await userSigner.getAddress();
            balancer = await balancerSigner.getAddress();
            userPk = '0x56d6ec847fd896d97961ec83ac0fddb9f40ad0f72f77704f2d14051a9ae81aa0';

            const ExchangeProxy = await ethers.getContractFactory("ExchangeProxy");
            const BFactory = await ethers.getContractFactory('BFactory');
            const BPool = await ethers.getContractFactory('BPool');
            const Weth9 = await ethers.getContractFactory('WETH9');
            const TToken = await ethers.getContractFactory("TToken");
            const TokenFactory = await ethers.getContractFactory("TToken");

            weth = await Weth9.deploy();
            dai = await TokenFactory.deploy('Dai Stablecoin', 'DAI', 18);
            mkr = await TokenFactory.deploy('Maker', 'MKR', 18);

            ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
            WETH = weth.address;
            DAI = dai.address;
            MKR = mkr.address;

            proxy = await ExchangeProxy.deploy(WETH);
            await proxy.deployed();
            PROXY = proxy.address;

            await weth.deposit({ value: toWei('25') });
            await dai.mint(relayer, toWei('10000'));
            await mkr.mint(relayer, toWei('200'));

            await weth.connect(userSigner).deposit({ from: user, value: toWei('25') });
            // await dai.mint(user, toWei('10000'));
            await mkr.mint(user, toWei('20'));

            factory = await BFactory.deploy();

            POOL1 = await factory.callStatic.newBPool();
            await factory.newBPool();
            pool1 = await ethers.getContractAt("BPool", POOL1);

            POOL2 = await factory.callStatic.newBPool();
            await factory.newBPool();
            pool2 = await ethers.getContractAt("BPool", POOL2);

            POOL3 = await factory.callStatic.newBPool();
            await factory.newBPool();
            pool3 = await ethers.getContractAt("BPool", POOL3);

            await weth.connect(userSigner).approve(PROXY, MAX, { from: user });
            await dai.connect(userSigner).approve(PROXY, MAX, { from: user });
            await mkr.connect(userSigner).approve(PROXY, MAX, { from: user });

            await weth.approve(POOL1, MAX);
            await dai.approve(POOL1, MAX);
            await mkr.approve(POOL1, MAX);

            await weth.approve(POOL2, MAX);
            await dai.approve(POOL2, MAX);
            await mkr.approve(POOL2, MAX);

            await weth.approve(POOL3, MAX);
            await dai.approve(POOL3, MAX);
            await mkr.approve(POOL3, MAX);

            await pool1.bind(WETH, toWei('6'), toWei('5'));
            await pool1.bind(DAI, toWei('1200'), toWei('5'));
            await pool1.bind(MKR, toWei('6'), toWei('5'));
            await pool1.finalize();

            await pool2.bind(WETH, toWei('2'), toWei('10'));
            await pool2.bind(MKR, toWei('2'), toWei('10'));
            await pool2.bind(DAI, toWei('800'), toWei('20'));
            await pool2.finalize();

            await pool3.bind(WETH, toWei('15'), toWei('5'));
            await pool3.bind(DAI, toWei('2500'), toWei('5'));
            await pool3.bind(MKR, toWei('15'), toWei('5'));
            await pool3.finalize();
        });

        it('Should fail when user addr different from signer', async () => {

          const swaps = [
              [
                  POOL1,
                  MKR,
                  DAI,
                  toWei('0.5'),
                  toWei('0'),
                  MAX,
              ],
              [
                  POOL2,
                  MKR,
                  DAI,
                  toWei('0.5'),
                  toWei('0'),
                  MAX,
              ],
              [
                  POOL3,
                  MKR,
                  DAI,
                  toWei('1'),
                  toWei('0'),
                  MAX,
              ],
          ];
          const totalAmountIn = toWei('2');
          const artifact = require('./../artifacts/ExchangeProxy.json');
          var iface = new ethers.utils.Interface(artifact.abi);

          const types = {
              EIP712Domain: [
                  { name: 'name', type: 'string' },
                  { name: 'version', type: 'string' },
                  { name: 'chainId', type: 'uint256' },
                  { name: 'verifyingContract', type: 'address' }
              ],
              MetaTransaction: [
                { name: "nonce", type: "uint256" },
                { name: "from", type: "address" },
                { name: "functionSignature", type: "bytes" }
              ]
          }

          const domain = {
              name: 'ExchangeProxy',
              version: '1',
              chainId: 42,                // !!!!!!! THIS IS CURRENTLY HARDCODED IN CONTRACT
              verifyingContract: PROXY
          }

          // https://github.com/ethers-io/ethers.js/issues/211
          const funcSig = iface.encodeFunctionData("batchSwapExactIn", [swaps, MKR, DAI, totalAmountIn, 0])
          const nonce = await proxy.getNonce(user);

          const message = {
              nonce: parseInt(nonce),
              from: user,
              functionSignature: funcSig
          }

          const hash = ethUtil.keccak256(
                Buffer.concat([
                    Buffer.from('1901', 'hex'),
                    structHash(types, 'EIP712Domain', domain),
                    structHash(types, 'MetaTransaction', message),
                ]),
            );

          const sig = ethUtil.ecsign(hash, ethUtil.toBuffer(userPk));

          // Admin calls this on-behalf of user
          let userEthBalBefore = await userSigner.getBalance();
          let relayerEthBalBefore = await relayerSigner.getBalance();
          let relayerWethBalBefore = await weth.balanceOf(relayer);
          let userDaiBalBefore = await dai.balanceOf(user);
          let userMkrBalBefore = await mkr.balanceOf(user);
          let userWethBalBefore = await weth.balanceOf(user);

          expect(userDaiBalBefore).to.equal(0);

          await expect(
            proxy.connect(relayerSigner).executeMetaTransaction(
                relayer,
                funcSig,
                ethUtil.bufferToHex(sig.r),
                ethUtil.bufferToHex(sig.s),
                sig.v)
          ).to.be.revertedWith("ERR_SIGNATURE");

        });


        it('testing', async () => {

          const swaps = [
              [
                  POOL1,
                  MKR,
                  DAI,
                  toWei('0.5'),
                  toWei('0'),
                  MAX,
              ],
              [
                  POOL2,
                  MKR,
                  DAI,
                  toWei('0.5'),
                  toWei('0'),
                  MAX,
              ],
              [
                  POOL3,
                  MKR,
                  DAI,
                  toWei('1'),
                  toWei('0'),
                  MAX,
              ],
          ];
          const totalAmountIn = toWei('2');
          const artifact = require('./../artifacts/ExchangeProxy.json');
          var iface = new ethers.utils.Interface(artifact.abi);

          const types = {
              EIP712Domain: [
                  { name: 'name', type: 'string' },
                  { name: 'version', type: 'string' },
                  { name: 'chainId', type: 'uint256' },
                  { name: 'verifyingContract', type: 'address' }
              ],
              MetaTransaction: [
                { name: "nonce", type: "uint256" },
                { name: "from", type: "address" },
                { name: "functionSignature", type: "bytes" }
              ]
          }

          const domain = {
              name: 'ExchangeProxy',
              version: '1',
              chainId: 42,                // !!!!!!! THIS IS CURRENTLY HARDCODED IN CONTRACT
              verifyingContract: PROXY
          }

          // https://github.com/ethers-io/ethers.js/issues/211
          const funcSig = iface.encodeFunctionData("batchSwapExactIn", [swaps, MKR, DAI, totalAmountIn, 0])
          const nonce = await proxy.getNonce(user);

          const message = {
              nonce: parseInt(nonce),
              from: user,
              functionSignature: funcSig
          }

          const hash = ethUtil.keccak256(
                Buffer.concat([
                    Buffer.from('1901', 'hex'),
                    structHash(types, 'EIP712Domain', domain),
                    structHash(types, 'MetaTransaction', message),
                ]),
            );

          const sig = ethUtil.ecsign(hash, ethUtil.toBuffer(userPk));

          // Admin calls this on-behalf of user
          let userEthBalBefore = await userSigner.getBalance();
          let relayerEthBalBefore = await relayerSigner.getBalance();
          let relayerWethBalBefore = await weth.balanceOf(relayer);
          let userDaiBalBefore = await dai.balanceOf(user);
          let userMkrBalBefore = await mkr.balanceOf(user);
          let userWethBalBefore = await weth.balanceOf(user);

          expect(userDaiBalBefore).to.equal(0);

          let tx = await proxy.connect(relayerSigner).executeMetaTransaction(
              user,
              funcSig,
              ethUtil.bufferToHex(sig.r),
              ethUtil.bufferToHex(sig.s),
              sig.v,
            {
              gasPrice: gasPrice // 30Gwei
            });

          tx = await tx.wait();

          let userEthBalAfter = await userSigner.getBalance();
          let userMkrBalAfter = await mkr.balanceOf(user);
          let relayerEthBalAfter = await relayerSigner.getBalance();
          let relayerWethBalAfter = await weth.balanceOf(relayer);

          console.log(tx.gasUsed.toString());
          // console.log(relayerWethBalBefore.toString());
          // console.log(relayerWethBalAfter.toString());
          console.log(`Relayer WETH payment: ${relayerWethBalAfter.sub(relayerWethBalBefore).toString()}`);

          expect(userEthBalBefore).to.equal(userEthBalAfter);         // i.e. no gas spent
          expect(userMkrBalAfter).to.equal(userMkrBalBefore.sub(totalAmountIn));
          expect(relayerEthBalBefore).to.equal(relayerEthBalAfter.add(tx.gasUsed.mul(gasPrice)));

          const swapFee = fromWei(await pool1.getSwapFee());
          const pool1Out = calcOutGivenIn(6, 5, 1200, 5, 0.5, swapFee);
          const pool2Out = calcOutGivenIn(2, 10, 800, 20, 0.5, swapFee);
          const pool3Out = calcOutGivenIn(15, 5, 2500, 5, 1, swapFee);

          const expectedTotalOut = pool1Out.plus(pool2Out).plus(pool3Out);
          let userDaiBalAfter = await dai.balanceOf(user);
          let userWethBalAfter = await weth.balanceOf(user);
          console.log(userDaiBalAfter.toString());
          console.log(expectedTotalOut.toString())

          const relDif = calcRelativeDiff(expectedTotalOut, Decimal(fromWei(userDaiBalAfter)));

          if (verbose) {
              console.log('batchSwapExactIn');
              console.log(`expected: ${expectedTotalOut})`);
              console.log(`actual  : ${fromWei(userDaiBalAfter)})`);
              console.log(`relDif  : ${relDif})`);
          }

          assert.isAtMost(relDif.toNumber(), (errorDelta * swaps.length));
        })
        
});
