/**
 * Demo Flow - Account Abstraction
 * 
 * File này demo các tính năng chính của Account Abstraction (ERC-4337):
 * 1. Tạo và sử dụng Smart Account
 * 2. Thực hiện giao dịch đơn lẻ và batch
 * 3. Sử dụng Paymaster để trả gas
 * 
 */

import './aa.init' // Import các setup cần thiết cho test
import { Wallet } from 'ethers'
import { ethers } from 'hardhat'
import { expect } from 'chai'

// Import các contract types được generate từ TypeChain
import {
  EntryPoint,                    // Contract chính của ERC-4337
  SimpleAccount,                 // Smart Account implementation
  SimpleAccountFactory,          // Factory để tạo SimpleAccount
  TestCounter,                   // Contract test để demo execution
  TestCounter__factory,
  TestPaymasterAcceptAll,        // Paymaster test để trả gas
  TestPaymasterAcceptAll__factory
} from '../typechain'

// Import các utility functions để tạo và xử lý UserOperation
import {
  fillAndSign,      // Tạo và ký UserOperation
  fillSignAndPack,  // Tạo, ký và pack UserOperation
  packUserOp        // Pack UserOperation thành format cần thiết
} from './UserOp'

// Import các helper functions từ testutils
import {
  createAccount,        // Tạo SimpleAccount mới
  createAccountOwner,   // Tạo wallet owner cho account
  createAddress,        // Tạo địa chỉ random
  deployEntryPoint,     // Deploy EntryPoint contract
  fund                  // Fund account với ETH
} from './testutils'
import { parseEther } from 'ethers/lib/utils'

describe('Demo Flow - Account Abstraction', function () {
  // Khai báo các biến global sẽ được sử dụng trong các test
  let entryPoint: EntryPoint              // Contract EntryPoint - trung tâm của ERC-4337
  let simpleAccountFactory: SimpleAccountFactory  // Factory để tạo SimpleAccount
  let accountOwner: Wallet                // Wallet owner của SimpleAccount
  let simpleAccount: SimpleAccount        // Smart Account instance
  let counter: TestCounter                // Contract test để demo execution
  const ethersSigner = ethers.provider.getSigner()  // Signer mặc định của Hardhat

  before(async function () {
    this.timeout(20000)  // Set timeout 20 giây cho setup
    
    // === BƯỚC 1: Deploy EntryPoint ===
    // EntryPoint là contract chính của ERC-4337, xử lý tất cả UserOperations
    entryPoint = await deployEntryPoint()
    console.log('EntryPoint deployed at:', entryPoint.address)

    // === BƯỚC 2: Tạo Account Owner ===
    // Account owner là wallet thông thường (EOA) sẽ sở hữu Smart Account
    accountOwner = createAccountOwner()
    console.log('EOA account:', accountOwner.address)

    // === BƯỚC 3: Tạo SimpleAccount ===
    // SimpleAccount là Smart Account implementation đơn giản
    // Nó cho phép owner thực hiện các giao dịch thông qua EntryPoint
    const { proxy: account, accountFactory: factory } = await createAccount(
      ethersSigner, 
      accountOwner.address, 
      entryPoint.address
    )
    simpleAccount = account
    simpleAccountFactory = factory
    console.log('Simple Contract Account created at:', simpleAccount.address)

    // === BƯỚC 5: Deploy Test Counter ===
    // TestCounter là contract đơn giản để demo việc thực hiện giao dịch
    counter = await new TestCounter__factory(ethersSigner).deploy()
    console.log('TestCounter deployed at:', counter.address)
  })

  describe('Paymaster Integration', () => {
    // === PAYMASTER LÀ GÌ? ===
    // Paymaster là contract cho phép bên thứ 3 trả gas cho user
    // Thay vì user phải có ETH để trả gas, paymaster sẽ trả thay
    // Điều này mở ra khả năng:
    // - DApp trả gas cho user
    // - Sponsor transaction
    // - Gasless transaction
    
    let paymaster: TestPaymasterAcceptAll  // Paymaster contract    
    before(async () => {
      // === DEPLOY PAYMASTER ===
      // TestPaymasterAcceptAll là paymaster test chấp nhận tất cả request
      paymaster = await new TestPaymasterAcceptAll__factory(ethersSigner).deploy(entryPoint.address)
      
      // Paymaster cần stake để đảm bảo an toàne
      // Stake sẽ bị phạt nếu paymaster hoạt động sai
      await paymaster.addStake(2, { value: parseEther('2') }) // Add stake
      
      // Paymaster cần deposit để trả gas cho user
      await paymaster.deposit({ value: parseEther('1') }) // Add deposit
      console.log('✅ Paymaster deployed at:', paymaster.address)
    })

    it('should execute transaction with paymaster sponsorship', async () => {
      console.log('\n🔄 Testing paymaster sponsorship...')
      
      // === CHUẨN BỊ GIAO DỊCH ===
      // Tạo giao dịch tương tự như test trước
      const countData = await counter.populateTransaction.count()
      const accountExec = await simpleAccount.populateTransaction.execute(
        counter.address,
        0,
        countData.data!
      )

      // === TẠO USEROPERATION VỚI PAYMASTER ===
      // Khác biệt chính: thêm paymaster vào UserOperation
      const userOp = await fillSignAndPack({
        sender: simpleAccount.address,
        callData: accountExec.data,
        paymaster: paymaster.address,              // Địa chỉ paymaster
        paymasterVerificationGasLimit: 1e6,       // Gas cho paymaster validation
        paymasterPostOpGasLimit: 1e5,             // Gas cho paymaster postOp
        verificationGasLimit: 1e6,
        callGasLimit: 1e6
      }, accountOwner, entryPoint)

      // === THỰC HIỆN GIAO DỊCH VỚI PAYMASTER ===
      const beneficiary = createAddress()
      const paymasterDepositBefore = await entryPoint.balanceOf(paymaster.address)
      const countBefore = await counter.counters(simpleAccount.address)
      
      // === LOG MINH CHỨNG AI TRẢ GAS ===
      const accountBalance2Before = await ethers.provider.getBalance(simpleAccount.address)
      const ethersSignerBalanceBefore = await ethers.provider.getBalance(await ethersSigner.getAddress())

      console.log('Transaction exec log start ------------------------------')
      const tx = await entryPoint.handleOps([userOp], beneficiary, {
        maxFeePerGas: 1e9,
        gasLimit: 1e7
      })
      console.log('Transaction exec log end ------------------------------')
      const receipt = await tx.wait()

      // === KIỂM TRA KẾT QUẢ ===
      const paymasterDepositAfter = await entryPoint.balanceOf(paymaster.address)
      const countAfter = await counter.counters(simpleAccount.address)
      const accountBalance2After = await ethers.provider.getBalance(simpleAccount.address)
      const ethersSignerBalanceAfter = await ethers.provider.getBalance(await ethersSigner.getAddress())

      expect(countAfter.toNumber()).to.equal(countBefore.toNumber() + 1)
      expect(paymasterDepositAfter).to.be.lt(paymasterDepositBefore) // Paymaster đã trả gas

      console.log('✅ Paymaster transaction executed successfully')
      console.log('   - Counter before:', countBefore.toNumber())
      console.log('   - Counter after:', countAfter.toNumber())
      console.log('   - Gas used:', receipt.gasUsed.toString())
      
      // === LOG KẾT QUẢ GAS PAYMENT ===
      console.log('💰 Gas Payment Results (Paymaster):')
      console.log('   - Account2 balance change:', ethers.utils.formatEther(accountBalance2Before.sub(accountBalance2After)), 'ETH')
      console.log('   - Paymaster deposit change:', ethers.utils.formatEther(paymasterDepositBefore.sub(paymasterDepositAfter)), 'ETH')
      console.log('   - EthersSigner paid:', ethers.utils.formatEther(ethersSignerBalanceBefore.sub(ethersSignerBalanceAfter)), 'ETH')
    })
  })

})
