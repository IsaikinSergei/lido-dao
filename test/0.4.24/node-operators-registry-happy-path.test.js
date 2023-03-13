const { contract, web3 } = require('hardhat')
const { assert } = require('../helpers/assert')

const signingKeys = require('../helpers/signing-keys')
const { ETH } = require('../helpers/utils')
const { DSMAttestMessage } = require('../helpers/signatures')
const { deployProtocol } = require('../helpers/protocol')
const { setupNodeOperatorsRegistry } = require('../helpers/staking-modules')

const ADDRESS_1 = '0x0000000000000000000000000000000000000001'
const ADDRESS_2 = '0x0000000000000000000000000000000000000002'
const ADDRESS_3 = '0x0000000000000000000000000000000000000003'

const NODE_OPERATORS = [
  {
    id: 0,
    name: 'Node operator #1',
    rewardAddressInitial: ADDRESS_1,
    totalSigningKeysCount: 10,
    depositedSigningKeysCount: 5,
    exitedSigningKeysCount: 1,
    vettedSigningKeysCount: 6,
    stuckValidatorsCount: 0,
    refundedValidatorsCount: 0,
    stuckPenaltyEndAt: 0,
  },
  {
    id: 1,
    isActive: false,
    name: 'Node operator #2',
    rewardAddressInitial: ADDRESS_2,
    totalSigningKeysCount: 15,
    depositedSigningKeysCount: 7,
    exitedSigningKeysCount: 0,
    vettedSigningKeysCount: 10,
    stuckValidatorsCount: 0,
    refundedValidatorsCount: 0,
    stuckPenaltyEndAt: 0,
  },
  {
    id: 2,
    isActive: false,
    name: 'Node operator #3',
    rewardAddressInitial: ADDRESS_3,
    totalSigningKeysCount: 10,
    depositedSigningKeysCount: 0,
    exitedSigningKeysCount: 0,
    vettedSigningKeysCount: 5,
    stuckValidatorsCount: 0,
    refundedValidatorsCount: 0,
    stuckPenaltyEndAt: 0,
  },
]

const Operator1 = NODE_OPERATORS[0]
// const Operator2 = NODE_OPERATORS[1]
const Operator3 = NODE_OPERATORS[2]

const forEachSync = async (arr, cb) => {
  for (let i = 0; i < arr.length; ++i) {
    await cb(arr[i], i)
  }
}

contract('NodeOperatorsRegistry', ([appManager, rewards1, rewards2, rewards3, user1, nobody]) => {
  // let app
  // let locator
  // let steth
  // let dao
  let dsm
  let lido
  let nor
  let stakingRouter
  let depositContract
  let depositRoot
  let voting
  let rewardAddresses
  let guardians
  let withdrawalCredentials

  before('deploy base app', async () => {
    const deployed = await deployProtocol({
      stakingModulesFactory: async (protocol) => {
        const curatedModule = await setupNodeOperatorsRegistry(protocol)
        return [
          {
            module: curatedModule,
            name: 'Curated',
            targetShares: 10000,
            moduleFee: 500,
            treasuryFee: 500,
          },
        ]
      },
    })

    rewardAddresses = [rewards1, rewards2, rewards3]

    // app = deployed.dao
    lido = deployed.pool
    nor = deployed.stakingModules[0]
    // steth = deployed.token
    // locator = deployed.lidoLocator
    stakingRouter = deployed.stakingRouter
    depositContract = deployed.depositContract
    depositRoot = await depositContract.get_deposit_root()
    dsm = deployed.depositSecurityModule
    guardians = deployed.guardians
    voting = deployed.voting.address
    // treasuryAddr = deployed.treasury.address

    withdrawalCredentials = '0x'.padEnd(66, '1234')
    await stakingRouter.setWithdrawalCredentials(withdrawalCredentials, { from: voting })
  })

  describe('Happy path', () => {
    it('Add node operator', async () => {
      await forEachSync(NODE_OPERATORS, async (operatorData, i) => {
        const initialName = `operator ${i + 1}`
        const tx = await nor.addNodeOperator(initialName, operatorData.rewardAddressInitial, { from: voting })
        const expectedStakingLimit = 0

        assert.emits(tx, 'NodeOperatorAdded', {
          nodeOperatorId: operatorData.id,
          name: initialName,
          rewardAddress: operatorData.rewardAddressInitial,
          stakingLimit: expectedStakingLimit,
        })

        assert.isTrue(await nor.getNodeOperatorIsActive(operatorData.id))
        const operator = await nor.getNodeOperator(operatorData.id, true)
        assert.isTrue(operator.active)
        assert.equals(operator.name, initialName)
        assert.equals(operator.rewardAddress, operatorData.rewardAddressInitial)
        assert.equals(operator.stakingLimit, 0)
        assert.equals(operator.stoppedValidators, 0)
        assert.equals(operator.totalSigningKeys, 0)
        assert.equals(operator.usedSigningKeys, 0)
      })

      assert.equals(await nor.getNodeOperatorsCount(), NODE_OPERATORS.length)
    })

    // TODO: Move this block after keys manipulations to check how it will affect them
    it('Deactivate node operator 3', async () => {
      const activeOperatorsBefore = await nor.getActiveNodeOperatorsCount()
      const tx = await nor.deactivateNodeOperator(Operator3.id, { from: voting })
      const operator = await nor.getNodeOperator(Operator3.id, true)
      const activeOperatorsAfter = await nor.getActiveNodeOperatorsCount()

      assert.isFalse(await nor.getNodeOperatorIsActive(Operator3.id))
      assert.isFalse(operator.active)
      assert.equals(Number(activeOperatorsBefore) - 1, Number(activeOperatorsAfter))
      assert.emits(tx, 'NodeOperatorActiveSet', { nodeOperatorId: Operator3.id, active: false })
    })

    it('Set name', async () => {
      await forEachSync(NODE_OPERATORS, async (operatorData, i) => {
        await nor.setNodeOperatorName(operatorData.id, operatorData.name, { from: voting })
        const operator = await nor.getNodeOperator(operatorData.id, true)
        assert.equals(operator.name, operatorData.name)
      })
    })

    it('Set reward address', async () => {
      await forEachSync(NODE_OPERATORS, async (operatorData, i) => {
        const rewardAddress = rewardAddresses[i]
        await nor.setNodeOperatorRewardAddress(operatorData.id, rewardAddress, { from: voting })
        const operator = await nor.getNodeOperator(operatorData.id, true)
        assert.equals(operator.rewardAddress, rewardAddress)
      })
    })

    it('Add signing keys', async () => {
      await forEachSync(NODE_OPERATORS, async (operatorData, i) => {
        const keys = new signingKeys.FakeValidatorKeys(operatorData.totalSigningKeysCount)
        await nor.addSigningKeys(operatorData.id, keys.count, ...keys.slice(), { from: voting })

        const operator = await nor.getNodeOperator(operatorData.id, true)
        const keysCount = await nor.getTotalSigningKeyCount(operatorData.id)
        const unusedKeysCount = await nor.getUnusedSigningKeyCount(operatorData.id)
        assert.equals(keys.count, operator.totalSigningKeys.toNumber())
        assert.equals(keys.count, keysCount)
        assert.equals(keys.count, unusedKeysCount)

        for (let i = 0; i < keys.count; ++i) {
          const { key, depositSignature } = await nor.getSigningKey(operatorData.id, i)
          const [expectedPublicKey, expectedSignature] = keys.get(i)
          assert.equals(key, expectedPublicKey)
          assert.equals(depositSignature, expectedSignature)
        }
      })
    })

    let stateTotalVetted = 0
    let stateTotaldeposited = 0

    it('Set staking limit', async () => {
      await forEachSync(NODE_OPERATORS, async (operatorData, i) => {
        if (!(await nor.getNodeOperatorIsActive(operatorData.id))) return
        stateTotalVetted += operatorData.vettedSigningKeysCount
        await nor.setNodeOperatorStakingLimit(operatorData.id, operatorData.vettedSigningKeysCount, { from: voting })
        const operator = await nor.getNodeOperator(operatorData.id, true)
        assert.equals(operator.stakingLimit, operatorData.vettedSigningKeysCount)
      })

      const stakingModuleSummary = await nor.getStakingModuleSummary()
      assert.equals(stakingModuleSummary.depositableValidatorsCount, stateTotalVetted)
    })

    it('Obtain deposit data', async () => {
      const [curated] = await stakingRouter.getStakingModules()

      await web3.eth.sendTransaction({ to: lido.address, from: user1, value: ETH(32) })

      const block = await web3.eth.getBlock('latest')
      const keysOpIndex = await nor.getKeysOpIndex()

      DSMAttestMessage.setMessagePrefix(await dsm.ATTEST_MESSAGE_PREFIX())

      const attest = new DSMAttestMessage(block.number, block.hash, depositRoot, curated.id, keysOpIndex)
      const signatures = [
        attest.sign(guardians.privateKeys[guardians.addresses[0]]),
        attest.sign(guardians.privateKeys[guardians.addresses[1]]),
      ]

      // triggers flow:
      // DSM.depositBufferedEther() -> Lido.deposit() -> StakingRouter.deposit() -> Module.obtainDepositData()
      await dsm.depositBufferedEther(block.number, block.hash, depositRoot, curated.id, keysOpIndex, '0x', signatures)

      stateTotaldeposited += 1

      const depositCallCount = await depositContract.totalCalls()
      assert.equals(depositCallCount, 1)

      const regCall = await depositContract.calls.call(0)
      const { key, depositSignature } = await nor.getSigningKey(Operator1.id, 0)
      assert.equal(regCall.pubkey, key)
      assert.equal(regCall.signature, depositSignature)
      assert.equal(regCall.withdrawal_credentials, withdrawalCredentials)
      assert.equals(regCall.value, ETH(32))

      const stakingModuleSummary = await nor.getStakingModuleSummary()
      assert.equals(stakingModuleSummary.totalDepositedValidators, stateTotaldeposited)
      assert.equals(stakingModuleSummary.depositableValidatorsCount, stateTotalVetted - stateTotaldeposited)
    })
  })
})
