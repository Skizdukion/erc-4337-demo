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

    // === BƯỚC 4: Fund Contract Account ===
    // Cần fund account với 1 ETH để có thể trả gas cho các giao dịch
    await fund(simpleAccount)
    console.log('Contract Account funded 1 ETH')

    // === BƯỚC 5: Deploy Test Counter ===
    // TestCounter là contract đơn giản để demo việc thực hiện giao dịch
    counter = await new TestCounter__factory(ethersSigner).deploy()
    console.log('TestCounter deployed at:', counter.address)
  })

  describe('Basic Account Operations', () => {
    it('should execute simple transaction', async () => {
      
      // === CHUẨN BỊ GIAO DỊCH ===
      // Tạo callData để gọi function count() của TestCounter
      const countData = await counter.populateTransaction.count()
      
      // Tạo callData để SimpleAccount thực hiện giao dịch
      // SimpleAccount.execute(target, value, data) sẽ gọi target với data
      const accountExec = await simpleAccount.populateTransaction.execute(
        counter.address,  // target: địa chỉ contract cần gọi
        0,                // value: ETH gửi kèm (0 trong trường hợp này)
        countData.data!   // data: callData của function count()
      )

      // === TẠO USEROPERATION ===
      // UserOperation là đối tượng chính trong ERC-4337
      // Nó chứa tất cả thông tin cần thiết để thực hiện giao dịch
      const userOp = await fillSignAndPack({
        sender: simpleAccount.address,    // Địa chỉ Smart Account
        callData: accountExec.data,       // Dữ liệu giao dịch
        verificationGasLimit: 1e6,        // Gas limit cho validation
        callGasLimit: 1e6                 // Gas limit cho execution
      }, accountOwner, entryPoint)        // Ký bởi account owner

      // === THỰC HIỆN GIAO DỊCH ===
      const beneficiary = createAddress()  // Địa chỉ nhận gas refund
      const countBefore = await counter.counters(simpleAccount.address)
      
      // === LOG MINH CHỨNG AI TRẢ GAS ===
      // const accountDepositBefore = await entryPoint.balanceOf(simpleAccount.address)
      const accountBalanceBefore = await ethers.provider.getBalance(simpleAccount.address)
      const ethersSignerBalanceBefore = await ethers.provider.getBalance(await ethersSigner.getAddress())
      
      // Gửi UserOperation đến EntryPoint để xử lý
      console.log('Transaction exec log start ------------------------------')
      const tx = await entryPoint.handleOps([userOp], beneficiary, {
        maxFeePerGas: 1e9,    // Max fee per gas
        gasLimit: 1e7         // Gas limit cho transaction
      })
      console.log('Transaction exec log end ------------------------------')

      const receipt = await tx.wait()

      // === KIỂM TRA KẾT QUẢ ===
      const countAfter = await counter.counters(simpleAccount.address)
      // const accountDepositAfter = await entryPoint.balanceOf(simpleAccount.address)
      const ethersSignerBalanceAfter = await ethers.provider.getBalance(await ethersSigner.getAddress())
      const accountBalanceAfter = await ethers.provider.getBalance(simpleAccount.address)
      
      expect(countAfter.toNumber()).to.equal(countBefore.toNumber() + 1)
      
      console.log('✅ Transaction executed successfully')
      console.log('   - Counter before:', countBefore.toNumber())
      console.log('   - Counter after:', countAfter.toNumber())
      console.log('   - Gas used:', receipt.gasUsed.toString())
      
      // === LOG KẾT QUẢ GAS PAYMENT ===
      console.log('💰 Gas Payment Results:')
      console.log('   - Simple Contract Account balance paid:', ethers.utils.formatEther(accountBalanceBefore.sub(accountBalanceAfter)))
      console.log('   - EthersSigner paid:', ethers.utils.formatEther(ethersSignerBalanceBefore.sub(ethersSignerBalanceAfter)), 'ETH')
    })

    // it('should execute batch transactions', async () => {
    //   console.log('\n🔄 Testing batch transactions...')
      
    //   // === CHUẨN BỊ BATCH GIAO DỊCH ===
    //   // Tạo 2 địa chỉ target để nhận ETH
    //   const target1 = createAddress()
    //   const target2 = createAddress()
      
    //   // Tạo callData cho batch execution
    //   // executeBatch cho phép thực hiện nhiều giao dịch trong 1 UserOperation
    //   const batchData = simpleAccount.interface.encodeFunctionData('executeBatch', [[
    //     { target: target1, value: parseEther('0.1'), data: '0x' },  // Gửi 0.1 ETH đến target1
    //     { target: target2, value: parseEther('0.05'), data: '0x' }  // Gửi 0.05 ETH đến target2
    //   ]])

    //   // === TẠO USEROPERATION CHO BATCH ===
    //   const userOp = await fillSignAndPack({
    //     sender: simpleAccount.address,
    //     callData: batchData,
    //     verificationGasLimit: 1e6,
    //     callGasLimit: 1e6
    //   }, accountOwner, entryPoint)

    //   // === THỰC HIỆN BATCH GIAO DỊCH ===
    //   const beneficiary = createAddress()
    //   const balance1Before = await ethers.provider.getBalance(target1)
    //   const balance2Before = await ethers.provider.getBalance(target2)
      
    //   // === LOG MINH CHỨNG AI TRẢ GAS ===
    //   const accountDepositBefore = await entryPoint.balanceOf(simpleAccount.address)
    //   const ethersSignerBalanceBefore = await ethers.provider.getBalance(await ethersSigner.getAddress())
      
    //   console.log('💰 Gas Payment Analysis (Batch):')
    //   console.log('   - Account deposit before:', ethers.utils.formatEther(accountDepositBefore), 'ETH')
    //   console.log('   - EthersSigner balance before:', ethers.utils.formatEther(ethersSignerBalanceBefore), 'ETH')

    //   const tx = await entryPoint.handleOps([userOp], beneficiary, {
    //     maxFeePerGas: 1e9,
    //     gasLimit: 1e7
    //   })
    //   const receipt = await tx.wait()

    //   // === KIỂM TRA KẾT QUẢ ===
    //   const balance1After = await ethers.provider.getBalance(target1)
    //   const balance2After = await ethers.provider.getBalance(target2)
    //   const accountDepositAfter = await entryPoint.balanceOf(simpleAccount.address)
    //   const ethersSignerBalanceAfter = await ethers.provider.getBalance(await ethersSigner.getAddress())

    //   expect(balance1After).to.equal(balance1Before.add(parseEther('0.1')))
    //   expect(balance2After).to.equal(balance2Before.add(parseEther('0.05')))
      
    //   console.log('✅ Batch transaction executed successfully')
    //   console.log('   - Target1 received:', parseEther('0.1').toString())
    //   console.log('   - Target2 received:', parseEther('0.05').toString())
    //   console.log('   - Gas used:', receipt.gasUsed.toString())
      
    //   // === LOG KẾT QUẢ GAS PAYMENT ===
    //   console.log('💰 Gas Payment Results (Batch):')
    //   console.log('   - Account deposit after:', ethers.utils.formatEther(accountDepositAfter), 'ETH')
    //   console.log('   - EthersSigner balance after:', ethers.utils.formatEther(ethersSignerBalanceAfter), 'ETH')
    //   console.log('   - Account deposit change:', ethers.utils.formatEther(accountDepositAfter.sub(accountDepositBefore)), 'ETH (negative = paid gas)')
    //   console.log('   - EthersSigner paid (balance decrease):', ethers.utils.formatEther(ethersSignerBalanceBefore.sub(ethersSignerBalanceAfter)), 'ETH')
    //   console.log('   - Beneficiary received gas refund:', ethers.utils.formatEther(await ethers.provider.getBalance(beneficiary)), 'ETH')
    //   console.log('   - Note: Account paid gas for UserOperation execution')
    // })
  })

  // describe('Paymaster Integration', () => {
  //   // === PAYMASTER LÀ GÌ? ===
  //   // Paymaster là contract cho phép bên thứ 3 trả gas cho user
  //   // Thay vì user phải có ETH để trả gas, paymaster sẽ trả thay
  //   // Điều này mở ra khả năng:
  //   // - DApp trả gas cho user
  //   // - Sponsor transaction
  //   // - Gasless transaction
    
  //   let paymaster: TestPaymasterAcceptAll  // Paymaster contract
  //   let account2Owner: Wallet              // Owner của account thứ 2
  //   let account2: SimpleAccount            // Account thứ 2 để test paymaster

  //   before(async () => {
  //     // === DEPLOY PAYMASTER ===
  //     // TestPaymasterAcceptAll là paymaster test chấp nhận tất cả request
  //     paymaster = await new TestPaymasterAcceptAll__factory(ethersSigner).deploy(entryPoint.address)
      
  //     // Paymaster cần stake để đảm bảo an toàn
  //     // Stake sẽ bị phạt nếu paymaster hoạt động sai
  //     await paymaster.addStake(2, { value: parseEther('2') }) // Add stake
      
  //     // Paymaster cần deposit để trả gas cho user
  //     await paymaster.deposit({ value: parseEther('1') }) // Add deposit
  //     console.log('✅ Paymaster deployed at:', paymaster.address)

  //     // === TẠO ACCOUNT THỨ 2 ===
  //     // Tạo account riêng để test paymaster (không fund ETH)
  //     account2Owner = createAccountOwner()
  //     const { proxy: account2Proxy } = await createAccount(
  //       ethersSigner,
  //       account2Owner.address,
  //       entryPoint.address
  //     )
  //     account2 = account2Proxy
  //     console.log('✅ Account2 created at:', account2.address)
  //   })

  //   it('should execute transaction with paymaster sponsorship', async () => {
  //     console.log('\n🔄 Testing paymaster sponsorship...')
      
  //     // === CHUẨN BỊ GIAO DỊCH ===
  //     // Tạo giao dịch tương tự như test trước
  //     const countData = await counter.populateTransaction.count()
  //     const accountExec = await account2.populateTransaction.execute(
  //       counter.address,
  //       0,
  //       countData.data!
  //     )

  //     // === TẠO USEROPERATION VỚI PAYMASTER ===
  //     // Khác biệt chính: thêm paymaster vào UserOperation
  //     const userOp = await fillSignAndPack({
  //       sender: account2.address,
  //       callData: accountExec.data,
  //       paymaster: paymaster.address,              // Địa chỉ paymaster
  //       paymasterVerificationGasLimit: 1e6,       // Gas cho paymaster validation
  //       paymasterPostOpGasLimit: 1e5,             // Gas cho paymaster postOp
  //       verificationGasLimit: 1e6,
  //       callGasLimit: 1e6
  //     }, account2Owner, entryPoint)

  //     // === THỰC HIỆN GIAO DỊCH VỚI PAYMASTER ===
  //     const beneficiary = createAddress()
  //     const paymasterDepositBefore = await entryPoint.balanceOf(paymaster.address)
  //     const countBefore = await counter.counters(account2.address)
      
  //     // === LOG MINH CHỨNG AI TRẢ GAS ===
  //     const account2DepositBefore = await entryPoint.balanceOf(account2.address)
  //     const ethersSignerBalanceBefore = await ethers.provider.getBalance(await ethersSigner.getAddress())
      
  //     console.log('💰 Gas Payment Analysis (Paymaster):')
  //     console.log('   - Account2 deposit before:', ethers.utils.formatEther(account2DepositBefore), 'ETH')
  //     console.log('   - Paymaster deposit before:', ethers.utils.formatEther(paymasterDepositBefore), 'ETH')
  //     console.log('   - EthersSigner balance before:', ethers.utils.formatEther(ethersSignerBalanceBefore), 'ETH')

  //     const tx = await entryPoint.handleOps([userOp], beneficiary, {
  //       maxFeePerGas: 1e9,
  //       gasLimit: 1e7
  //     })
  //     const receipt = await tx.wait()

  //     // === KIỂM TRA KẾT QUẢ ===
  //     const paymasterDepositAfter = await entryPoint.balanceOf(paymaster.address)
  //     const countAfter = await counter.counters(account2.address)
  //     const account2DepositAfter = await entryPoint.balanceOf(account2.address)
  //     const ethersSignerBalanceAfter = await ethers.provider.getBalance(await ethersSigner.getAddress())

  //     expect(countAfter.toNumber()).to.equal(countBefore.toNumber() + 1)
  //     expect(paymasterDepositAfter).to.be.lt(paymasterDepositBefore) // Paymaster đã trả gas

  //     console.log('✅ Paymaster transaction executed successfully')
  //     console.log('   - Counter before:', countBefore.toNumber())
  //     console.log('   - Counter after:', countAfter.toNumber())
  //     console.log('   - Gas used:', receipt.gasUsed.toString())
      
  //     // === LOG KẾT QUẢ GAS PAYMENT ===
  //     console.log('💰 Gas Payment Results (Paymaster):')
  //     console.log('   - Account2 deposit after:', ethers.utils.formatEther(account2DepositAfter), 'ETH')
  //     console.log('   - Paymaster deposit after:', ethers.utils.formatEther(paymasterDepositAfter), 'ETH')
  //     console.log('   - EthersSigner balance after:', ethers.utils.formatEther(ethersSignerBalanceAfter), 'ETH')
  //     console.log('   - Account2 deposit change:', ethers.utils.formatEther(account2DepositAfter.sub(account2DepositBefore)), 'ETH (no change = gasless)')
  //     console.log('   - Paymaster deposit change:', ethers.utils.formatEther(paymasterDepositAfter.sub(paymasterDepositBefore)), 'ETH (negative = paid gas)')
  //     console.log('   - EthersSigner paid (balance decrease):', ethers.utils.formatEther(ethersSignerBalanceBefore.sub(ethersSignerBalanceAfter)), 'ETH')
  //     console.log('   - Beneficiary received gas refund:', ethers.utils.formatEther(await ethers.provider.getBalance(beneficiary)), 'ETH')
  //     console.log('   - Note: Paymaster paid gas, Account2 had gasless transaction')
  //   })
  // })

})
