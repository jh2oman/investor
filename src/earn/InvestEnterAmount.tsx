import { NativeStackScreenProps } from '@react-navigation/native-stack'
import BigNumber from 'bignumber.js'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Keyboard, TextInput as RNTextInput, StyleSheet, Text, View } from 'react-native'
import { Slider } from 'react-native-awesome-slider'
import { useSharedValue } from 'react-native-reanimated'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { registryContractAbi } from 'src/abis/Registry'
import AppAnalytics from 'src/analytics/AppAnalytics'
import { SendEvents } from 'src/analytics/Events'
import BackButton from 'src/components/BackButton'
import BottomSheet, { BottomSheetModalRefType } from 'src/components/BottomSheet'
import Button, { BtnSizes, BtnTypes } from 'src/components/Button'
import InLineNotification, { NotificationVariant } from 'src/components/InLineNotification'
import KeyboardAwareScrollView from 'src/components/KeyboardAwareScrollView'
import { LabelWithInfo } from 'src/components/LabelWithInfo'
import RowDivider from 'src/components/RowDivider'
import TokenBottomSheet, {
  TokenBottomSheetProps,
  TokenPickerOrigin,
} from 'src/components/TokenBottomSheet'
import TokenDisplay from 'src/components/TokenDisplay'
import TokenEnterAmount, {
  FETCH_UPDATED_TRANSACTIONS_DEBOUNCE_TIME_MS,
  useEnterAmount,
} from 'src/components/TokenEnterAmount'
import CustomHeader from 'src/components/header/CustomHeader'
import { usePrepareInvestTransactionsCallback } from 'src/earn/hooks'
import { depositStatusSelector } from 'src/earn/selectors'
import { depositStart } from 'src/earn/slice'
import { getSwapToAmountInDecimals } from 'src/earn/utils'
import { CICOFlow } from 'src/fiatExchanges/types'
import ArrowRightThick from 'src/icons/ArrowRightThick'
import { navigate } from 'src/navigator/NavigationService'
import { Screens } from 'src/navigator/Screens'
import { StackParamList } from 'src/navigator/types'
import { earnPositionsSelector, hooksApiUrlSelector } from 'src/positions/selectors'
import { EarnPosition } from 'src/positions/types'
import { useDispatch, useSelector } from 'src/redux/hooks'
import EnterAmountOptions from 'src/send/EnterAmountOptions'
import { NETWORK_NAMES } from 'src/shared/conts'
import Colors from 'src/styles/colors'
import { typeScale } from 'src/styles/fonts'
import { Spacing } from 'src/styles/styles'
import { SwapTransaction } from 'src/swap/types'
import { useSwappableTokens, useTokenInfo } from 'src/tokens/hooks'
import { feeCurrenciesByNetworkIdSelector, feeCurrenciesSelector } from 'src/tokens/selectors'
import { TokenBalance } from 'src/tokens/slice'
import Logger from 'src/utils/Logger'
import { publicClient } from 'src/viem'
import {
  getFeeCurrencyAndAmounts,
  PreparedTransactionsResult,
  prepareTransactions,
  TransactionRequest,
} from 'src/viem/prepareTransactions'
import { getSerializablePreparedTransactions } from 'src/viem/preparedTransactionSerialization'
import { networkIdToNetwork } from 'src/web3/networkConfig'
import { walletAddressSelector } from 'src/web3/selectors'
import { Address, encodeFunctionData, isAddress, stringToHex } from 'viem'

type Props = NativeStackScreenProps<StackParamList, Screens.InvestEnterAmount>

const TAG = 'InvestEnterAmount'

export default function InvestEnterAmount({ route }: Props) {
  const { t } = useTranslation()
  const insets = useSafeAreaInsets()
  const dispatch = useDispatch()

  const pools = useSelector(earnPositionsSelector)
  const mode = 'invest'
  const { swappableFromTokens: swappableTokens } = useSwappableTokens()
  console.log(
    swappableTokens.map((token) => ({
      networkId: token.networkId,
      symbol: token.symbol,
    }))
  )

  const split = pools.map((pool) => new BigNumber(1).dividedBy(pools.length).toString())

  // We do not need to check withdrawal status/show a spinner for a pending
  // withdrawal, since withdrawals navigate to a separate confirmation screen.
  const depositStatus = useSelector(depositStatusSelector)
  const transactionSubmitted = depositStatus === 'loading'

  const availableInputTokens = swappableTokens

  /**
   * Use different balance for the withdrawal flow. As described in this discussion
   * (https://github.com/valora-inc/wallet/pull/6246#discussion_r1883426564) the intent of this
   * is to abstract away the LP token from the user and just display the token they're depositing,
   * so we need to convert the LP token balance to deposit and back to LP token when transacting."
   */
  const [inputToken, setInputToken] = useState(() => ({
    ...availableInputTokens[0],
    balance: availableInputTokens[0].balance,
  }))

  const inputRef = useRef<RNTextInput>(null)
  const tokenBottomSheetRef = useRef<BottomSheetModalRefType>(null)
  const reviewBottomSheetRef = useRef<BottomSheetModalRefType>(null)
  // const feeDetailsBottomSheetRef = useRef<BottomSheetModalRefType>(null)
  // const swapDetailsBottomSheetRef = useRef<BottomSheetModalRefType>(null)

  const [selectedPercentage, setSelectedPercentage] = useState<number | null>(null)
  const hooksApiUrl = useSelector(hooksApiUrlSelector)
  const walletAddress = useSelector(walletAddressSelector)

  const {
    prepareTransactionsResult: {
      prepareTransactionsResult,
      // swapTransactions
    } = {},
    refreshPreparedTransactions,
    clearPreparedTransactions,
    prepareTransactionError,
    isPreparingTransactions,
  } = usePrepareInvestTransactionsCallback()

  const {
    amount,
    replaceAmount,
    amountType,
    processedAmounts,
    handleAmountInputChange,
    handleToggleAmountType,
    handleSelectPercentageAmount,
  } = useEnterAmount({
    token: inputToken,
    inputRef,
    onHandleAmountInputChange: () => {
      setSelectedPercentage(null)
    },
  })

  const onOpenTokenPicker = () => {
    tokenBottomSheetRef.current?.snapToIndex(0)
    AppAnalytics.track(SendEvents.token_dropdown_opened, {
      currentTokenId: inputToken.tokenId,
      currentTokenAddress: inputToken.address,
      currentNetworkId: inputToken.networkId,
    })
  }

  const onSelectToken: TokenBottomSheetProps['onTokenSelected'] = (selectedToken) => {
    // Use different balance for the withdrawal flow.
    setInputToken({
      ...selectedToken,
      balance: selectedToken.balance,
    })
    replaceAmount('')
    tokenBottomSheetRef.current?.close()
    // NOTE: analytics is already fired by the bottom sheet, don't need one here
  }

  const handleRefreshPreparedTransactions = (
    amount: BigNumber,
    token: TokenBalance,
    feeCurrencies: TokenBalance[]
  ) => {
    if (!walletAddress || !isAddress(walletAddress)) {
      Logger.error(TAG, 'Wallet address not set. Cannot refresh prepared transactions.')
      return
    }

    return refreshPreparedTransactions({
      amount: amount.toString(),
      split,
      token,
      walletAddress,
      feeCurrencies,
      pools,
      hooksApiUrl,
      shortcutId: mode,
      useMax: selectedPercentage === 1,
    })
  }

  // This is for withdrawals as we want the user to be able to input the amounts in the deposit token
  const { transactionToken, transactionTokenAmount } = useMemo(() => {
    const transactionToken = inputToken
    const transactionTokenAmount = processedAmounts.token.bignum

    return {
      transactionToken,
      transactionTokenAmount,
    }
  }, [inputToken, processedAmounts.token.bignum, pools])

  const feeCurrencies = useSelector((state) =>
    feeCurrenciesSelector(state, transactionToken.networkId)
  )

  const allFeeCurrencies = useSelector(feeCurrenciesByNetworkIdSelector)

  useEffect(() => {
    clearPreparedTransactions()

    if (
      !processedAmounts.token.bignum ||
      !transactionTokenAmount ||
      processedAmounts.token.bignum.isLessThanOrEqualTo(0) ||
      processedAmounts.token.bignum.isGreaterThan(inputToken.balance)
    ) {
      return
    }
    const debouncedRefreshTransactions = setTimeout(() => {
      return handleRefreshPreparedTransactions(
        transactionTokenAmount,
        transactionToken,
        feeCurrencies
      )
    }, FETCH_UPDATED_TRANSACTIONS_DEBOUNCE_TIME_MS)
    return () => clearTimeout(debouncedRefreshTransactions)
  }, [processedAmounts.token.bignum?.toString(), mode, transactionToken, inputToken, feeCurrencies])

  const showLowerAmountError =
    processedAmounts.token.bignum && processedAmounts.token.bignum.gt(inputToken.balance)
  const showNotEnoughBalanceForGasWarning =
    !showLowerAmountError &&
    prepareTransactionsResult &&
    prepareTransactionsResult.type === 'not-enough-balance-for-gas'
  const transactionIsPossible =
    !showLowerAmountError &&
    prepareTransactionsResult &&
    prepareTransactionsResult.type === 'possible' &&
    prepareTransactionsResult.transactions.length > 0

  const disabled =
    // Should disable if the user enters 0, has enough balance but the transaction
    // is not possible, does not have enough balance, or if transaction is already
    // submitted
    !!processedAmounts.token.bignum?.isZero() || !transactionIsPossible || transactionSubmitted

  const onSelectPercentageAmount = (percentage: number) => {
    handleSelectPercentageAmount(percentage)
    setSelectedPercentage(percentage)

    AppAnalytics.track(SendEvents.send_percentage_selected, {
      tokenId: inputToken.tokenId,
      tokenAddress: inputToken.address,
      networkId: inputToken.networkId,
      percentage: percentage * 100,
      flow: 'earn',
    })
  }

  const onPressContinue = async () => {
    if (!processedAmounts.token.bignum || !transactionToken) {
      // should never happen
      return
    }
    const REGISTRY_CONTRACT_ADDRESS = '0xBa9655677f4E42DD289F5b7888170bC0c7dA8Cdc'
    const networkIds = new Set(pools.map((pool) => pool.networkId))
    const beefyProtocolHex = stringToHex('beefy', { size: 32 })
    const investorReferrerHex = stringToHex('investor', { size: 32 })
    const preparedRegisterTransactions = [] as TransactionRequest[][]
    for await (const networkId of networkIds) {
      const client = publicClient[networkIdToNetwork[networkId]]
      const isUserRegisteredForProtocols = await client.readContract({
        address: REGISTRY_CONTRACT_ADDRESS,
        abi: registryContractAbi,
        functionName: 'isUserRegistered',
        args: [walletAddress as Address, [beefyProtocolHex]],
      })
      console.log('isUserRegisteredForProtocols', networkId, isUserRegisteredForProtocols)
      if (!isUserRegisteredForProtocols[0]) {
        const registerTransaction: TransactionRequest = {
          from: walletAddress as Address,
          to: REGISTRY_CONTRACT_ADDRESS,
          data: encodeFunctionData({
            abi: registryContractAbi,
            functionName: 'registerReferrals',
            args: [investorReferrerHex, [beefyProtocolHex]],
          }),
        }

        const preparedTransaction = await prepareTransactions({
          feeCurrencies: allFeeCurrencies[networkId]!,
          baseTransactions: [registerTransaction],
          origin: 'earn-deposit',
        })
        if (preparedTransaction.type === 'possible') {
          preparedRegisterTransactions.push(preparedTransaction.transactions)
        }
      }
    }
    // reviewBottomSheetRef.current?.snapToIndex(0)
    prepareTransactionsResult &&
      prepareTransactionsResult?.type === 'possible' &&
      dispatch(
        depositStart({
          split,
          amount,
          pools,
          preparedTransactions: getSerializablePreparedTransactions(
            prepareTransactionsResult.transactions
          ),
          fromTokenId: inputToken.tokenId,
          fromTokenAmount: processedAmounts.token.bignum.toString(),
          registerTransactions: getSerializablePreparedTransactions(
            preparedRegisterTransactions.flat()
          ),
        })
      )
  }

  const dropdownEnabled = availableInputTokens.length > 1

  const progress = useSharedValue(30)
  const min = useSharedValue(0)
  const max = useSharedValue(100)

  return (
    <SafeAreaView style={styles.safeAreaContainer} edges={['top']}>
      <CustomHeader style={{ paddingHorizontal: Spacing.Thick24 }} left={<BackButton />} />
      <KeyboardAwareScrollView
        contentContainerStyle={[
          styles.contentContainer,
          {
            paddingBottom: Math.max(insets.bottom, Spacing.Thick24),
          },
        ]}
        onScrollBeginDrag={() => {
          Keyboard.dismiss()
        }}
      >
        <View style={styles.inputContainer}>
          <Text style={styles.title}>{'What is your level of risk tolerance?'}</Text>
          <View>
            <Slider
              progress={progress}
              minimumValue={min}
              maximumValue={max}
              style={styles.container}
            />
          </View>
          <Text style={styles.title}>{t('earnFlow.enterAmount.title')}</Text>
          <TokenEnterAmount
            autoFocus
            testID="EarnEnterAmount"
            token={inputToken}
            inputValue={amount}
            inputRef={inputRef}
            tokenAmount={processedAmounts.token.displayAmount}
            localAmount={processedAmounts.local.displayAmount}
            onInputChange={handleAmountInputChange}
            amountType={amountType}
            toggleAmountType={handleToggleAmountType}
            onOpenTokenPicker={dropdownEnabled ? onOpenTokenPicker : undefined}
          />
          {
            // processedAmounts.token.bignum && prepareTransactionsResult && (
            //   <TransactionDepositDetails
            //     pool={pool}
            //     token={inputToken}
            //     tokenAmount={processedAmounts.token.bignum}
            //     prepareTransactionsResult={prepareTransactionsResult}
            //     feeDetailsBottomSheetRef={feeDetailsBottomSheetRef}
            //     swapDetailsBottomSheetRef={swapDetailsBottomSheetRef}
            //     swapTransaction={swapTransaction}
            //   />
            // )
          }
        </View>

        {showNotEnoughBalanceForGasWarning && (
          <InLineNotification
            variant={NotificationVariant.Warning}
            title={t('earnFlow.enterAmount.notEnoughBalanceForGasWarning.title', {
              feeTokenSymbol: prepareTransactionsResult.feeCurrencies[0].symbol,
            })}
            description={t('earnFlow.enterAmount.notEnoughBalanceForGasWarning.description', {
              feeTokenSymbol: prepareTransactionsResult.feeCurrencies[0].symbol,
              network: NETWORK_NAMES[prepareTransactionsResult.feeCurrencies[0].networkId],
            })}
            ctaLabel={t('earnFlow.enterAmount.notEnoughBalanceForGasWarning.noGasCta', {
              feeTokenSymbol: feeCurrencies[0].symbol,
              network: NETWORK_NAMES[prepareTransactionsResult.feeCurrencies[0].networkId],
            })}
            onPressCta={() => {
              // AppAnalytics.track(EarnEvents.earn_deposit_add_gas_press, {
              //   gasTokenId: feeCurrencies[0].tokenId,
              //   depositTokenId: pool.dataProps.depositTokenId,
              //   networkId: pool.networkId,
              //   providerId: pool.appId,
              //   poolId: pool.positionId,
              // })
              navigate(Screens.FiatExchangeAmount, {
                tokenId: prepareTransactionsResult.feeCurrencies[0].tokenId,
                flow: CICOFlow.CashIn,
                tokenSymbol: prepareTransactionsResult.feeCurrencies[0].symbol,
              })
            }}
            style={styles.warning}
            testID="EarnEnterAmount/NotEnoughForGasWarning"
          />
        )}
        {showLowerAmountError && (
          <InLineNotification
            variant={NotificationVariant.Warning}
            title={t('sendEnterAmountScreen.insufficientBalanceWarning.title', {
              tokenSymbol: inputToken.symbol,
            })}
            description={t('sendEnterAmountScreen.insufficientBalanceWarning.description', {
              tokenSymbol: inputToken.symbol,
            })}
            style={styles.warning}
            testID="EarnEnterAmount/NotEnoughBalanceWarning"
          />
        )}
        {prepareTransactionError && (
          <InLineNotification
            variant={NotificationVariant.Error}
            title={t('sendEnterAmountScreen.prepareTransactionError.title')}
            description={t('sendEnterAmountScreen.prepareTransactionError.description')}
            style={styles.warning}
            testID="EarnEnterAmount/PrepareTransactionError"
          />
        )}
        <EnterAmountOptions
          onPressAmount={onSelectPercentageAmount}
          selectedAmount={selectedPercentage}
          testID="EarnEnterAmount/AmountOptions"
        />
        <Button
          onPress={onPressContinue}
          text={t('earnFlow.enterAmount.continue')}
          size={BtnSizes.FULL}
          disabled={disabled}
          style={styles.continueButton}
          showLoading={isPreparingTransactions || transactionSubmitted}
          testID="EarnEnterAmount/Continue"
        />
      </KeyboardAwareScrollView>
      {
        // processedAmounts.token.bignum && (
        //   <FeeDetailsBottomSheet
        //     forwardedRef={feeDetailsBottomSheetRef}
        //     testID="FeeDetailsBottomSheet"
        //     feeCurrency={feeCurrency}
        //     estimatedFeeAmount={estimatedFeeAmount}
        //     maxFeeAmount={maxFeeAmount}
        //     swapTransaction={swapTransaction}
        //     pool={pool}
        //     token={inputToken}
        //     tokenAmount={processedAmounts.token.bignum}
        //     isWithdrawal={false}
        //   />
        // )
      }
      {
        // swapTransaction && processedAmounts.token.bignum && (
        //   <SwapDetailsBottomSheet
        //     forwardedRef={swapDetailsBottomSheetRef}
        //     testID="SwapDetailsBottomSheet"
        //     swapTransaction={swapTransaction}
        //     token={inputToken}
        //     pool={pool}
        //     tokenAmount={processedAmounts.token.bignum}
        //     parsedTokenAmount={processedAmounts.token.bignum}
        //   />
        // )
      }
      {
        // processedAmounts.token.bignum && prepareTransactionsResult?.type === 'possible' && (
        //   <EarnDepositBottomSheet
        //     forwardedRef={reviewBottomSheetRef}
        //     preparedTransaction={prepareTransactionsResult}
        //     inputAmount={processedAmounts.token.bignum}
        //     pool={pool}
        //     mode={mode}
        //     swapTransaction={swapTransaction}
        //     inputTokenId={inputToken.tokenId}
        //   />
        // )
      }
      <TokenBottomSheet
        forwardedRef={tokenBottomSheetRef}
        origin={TokenPickerOrigin.Earn}
        onTokenSelected={onSelectToken}
        tokens={availableInputTokens}
        title={t('sendEnterAmountScreen.selectToken')}
        titleStyle={styles.title}
      />
    </SafeAreaView>
  )
}

function TransactionDepositDetails({
  pool,
  token,
  tokenAmount,
  prepareTransactionsResult,
  swapTransaction,
  feeDetailsBottomSheetRef,
  swapDetailsBottomSheetRef,
}: {
  pool: EarnPosition
  token: TokenBalance
  tokenAmount: BigNumber
  prepareTransactionsResult: PreparedTransactionsResult
  swapTransaction?: SwapTransaction
  feeDetailsBottomSheetRef: React.RefObject<BottomSheetModalRefType>
  swapDetailsBottomSheetRef: React.RefObject<BottomSheetModalRefType>
}) {
  const { t } = useTranslation()
  const { maxFeeAmount, feeCurrency } = getFeeCurrencyAndAmounts(prepareTransactionsResult)

  const depositAmount = useMemo(
    () =>
      swapTransaction
        ? getSwapToAmountInDecimals({ swapTransaction, fromAmount: tokenAmount }).toString()
        : tokenAmount.toString(),
    [tokenAmount, swapTransaction]
  )

  return (
    feeCurrency &&
    maxFeeAmount && (
      <View style={styles.txDetailsContainer} testID="EnterAmountDepositInfoCard">
        {swapTransaction && (
          <View style={styles.txDetailsLineItem}>
            <LabelWithInfo
              label={t('earnFlow.enterAmount.swap')}
              onPress={() => {
                swapDetailsBottomSheetRef?.current?.snapToIndex(0)
              }}
              testID="LabelWithInfo/SwapLabel"
            />
            <View style={styles.txDetailsValue}>
              <TokenDisplay
                testID="EarnEnterAmount/Swap/From"
                tokenId={token.tokenId}
                amount={tokenAmount.toString()}
                showLocalAmount={false}
                style={styles.txDetailsValueText}
              />
              <ArrowRightThick size={20} color={Colors.white} />
              <TokenDisplay
                testID="EarnEnterAmount/Swap/To"
                tokenId={pool.dataProps.depositTokenId}
                amount={depositAmount}
                showLocalAmount={false}
                style={styles.txDetailsValueText}
              />
            </View>
          </View>
        )}
        <View style={styles.txDetailsLineItem}>
          <LabelWithInfo label={t('earnFlow.enterAmount.deposit')} />
          <View style={styles.txDetailsValue}>
            <TokenDisplay
              tokenId={pool.dataProps.depositTokenId}
              testID="EarnEnterAmount/Deposit/Crypto"
              amount={depositAmount}
              showLocalAmount={false}
              style={styles.txDetailsValueText}
            />
            <Text style={[styles.txDetailsValueText, styles.gray4]}>
              {'('}
              <TokenDisplay
                testID="EarnEnterAmount/Deposit/Fiat"
                tokenId={pool.dataProps.depositTokenId}
                amount={depositAmount}
                showLocalAmount={true}
              />
              {')'}
            </Text>
          </View>
        </View>
        <View style={styles.txDetailsLineItem}>
          <LabelWithInfo
            label={t('earnFlow.enterAmount.fees')}
            onPress={() => {
              feeDetailsBottomSheetRef?.current?.snapToIndex(0)
            }}
            testID="LabelWithInfo/FeeLabel"
          />
          <View style={styles.txDetailsValue}>
            <TokenDisplay
              testID="EarnEnterAmount/Fees"
              tokenId={feeCurrency.tokenId}
              // TODO: add swap fees to this amount
              amount={maxFeeAmount.toString()}
              style={styles.txDetailsValueText}
            />
          </View>
        </View>
      </View>
    )
  )
}

// Might be sharable with src/swap/FeeInfoBottomSheet.tsx
function FeeDetailsBottomSheet({
  forwardedRef,
  testID,
  feeCurrency,
  estimatedFeeAmount,
  maxFeeAmount,
  swapTransaction,
  pool,
  token,
  tokenAmount,
  isWithdrawal,
}: {
  forwardedRef: React.RefObject<BottomSheetModalRefType>
  testID: string
  feeCurrency?: TokenBalance
  estimatedFeeAmount?: BigNumber
  maxFeeAmount?: BigNumber
  swapTransaction?: SwapTransaction | undefined
  pool: EarnPosition
  token: TokenBalance
  tokenAmount: BigNumber
  isWithdrawal: boolean
}) {
  const { t } = useTranslation()
  const inputToken = useTokenInfo(pool.dataProps.depositTokenId)

  if (!inputToken) {
    // should never happen
    throw new Error(`Token info not found for token ID ${pool.dataProps.depositTokenId}`)
  }

  const swapFeeAmount = useMemo(() => {
    if (swapTransaction && swapTransaction.appFeePercentageIncludedInPrice) {
      return tokenAmount.multipliedBy(
        new BigNumber(swapTransaction.appFeePercentageIncludedInPrice).shiftedBy(-2) // To convert from percentage to decimal
      )
    }
  }, [swapTransaction, token])

  const descriptionContainerStyle = [
    styles.bottomSheetDescriptionContainer,
    !swapFeeAmount && { marginTop: Spacing.Regular16 },
  ]

  const handleClose = () => forwardedRef.current?.close()
  return (
    <BottomSheet
      forwardedRef={forwardedRef}
      title={t('earnFlow.enterAmount.feeBottomSheet.feeDetails')}
      testId={testID}
    >
      <View style={styles.bottomSheetTextContent}>
        <View style={styles.gap8}>
          <View style={styles.bottomSheetLineItem} testID="EstNetworkFee">
            <Text style={styles.bottomSheetLineLabel}>
              {t('earnFlow.enterAmount.feeBottomSheet.estNetworkFee')}
            </Text>
            {feeCurrency && estimatedFeeAmount && (
              <Text style={styles.bottomSheetLineLabelText} testID="EstNetworkFee/Value">
                {'≈ '}
                <TokenDisplay
                  tokenId={feeCurrency.tokenId}
                  amount={estimatedFeeAmount.toString()}
                />
                {' ('}
                <TokenDisplay
                  tokenId={feeCurrency.tokenId}
                  showLocalAmount={false}
                  amount={estimatedFeeAmount.toString()}
                />
                {')'}
              </Text>
            )}
          </View>
          <View style={styles.bottomSheetLineItem} testID="MaxNetworkFee">
            <Text style={styles.bottomSheetLineLabel}>
              {t('earnFlow.enterAmount.feeBottomSheet.maxNetworkFee')}
            </Text>
            {feeCurrency && maxFeeAmount && (
              <Text style={styles.bottomSheetLineLabelText} testID="MaxNetworkFee/Value">
                {'≈ '}
                <TokenDisplay tokenId={feeCurrency.tokenId} amount={maxFeeAmount.toString()} />
                {' ('}
                <TokenDisplay
                  tokenId={feeCurrency.tokenId}
                  showLocalAmount={false}
                  amount={maxFeeAmount.toString()}
                />
                {')'}
              </Text>
            )}
          </View>
        </View>
        <RowDivider />
        {swapFeeAmount && (
          <View style={styles.bottomSheetLineItem} testID="SwapFee">
            <Text style={styles.bottomSheetLineLabel}>
              {t('earnFlow.enterAmount.feeBottomSheet.appSwapFee')}
            </Text>
            <Text style={styles.bottomSheetLineLabelText} testID="SwapFee/Value">
              {'≈ '}
              <TokenDisplay tokenId={token.tokenId} amount={swapFeeAmount.toString()} />
              {' ('}
              <TokenDisplay
                tokenId={token.tokenId}
                showLocalAmount={false}
                amount={swapFeeAmount.toString()}
              />
              {')'}
            </Text>
          </View>
        )}
        <View style={descriptionContainerStyle}>
          <Text style={styles.bottomSheetDescriptionTitle}>
            {t('earnFlow.enterAmount.feeBottomSheet.moreInformation')}
          </Text>
          {swapFeeAmount ? (
            <Text style={styles.bottomSheetDescriptionText}>
              {t('earnFlow.enterAmount.feeBottomSheet.networkSwapFeeDescription', {
                appFeePercentage: swapTransaction?.appFeePercentageIncludedInPrice,
              })}
            </Text>
          ) : (
            <Text style={styles.bottomSheetDescriptionText}>
              {isWithdrawal
                ? t('earnFlow.enterAmount.feeBottomSheet.networkFeeDescriptionWithdrawal')
                : t('earnFlow.enterAmount.feeBottomSheet.networkFeeDescription')}
            </Text>
          )}
        </View>
      </View>
      <Button
        onPress={handleClose}
        text={t('earnFlow.poolInfoScreen.infoBottomSheet.gotIt')}
        size={BtnSizes.FULL}
        type={BtnTypes.SECONDARY}
        testID="FeeDetailsBottomSheet/GotIt"
      />
    </BottomSheet>
  )
}

function SwapDetailsBottomSheet({
  forwardedRef,
  testID,
  swapTransaction,
  pool,
  token,
  tokenAmount,
  parsedTokenAmount,
}: {
  forwardedRef: React.RefObject<BottomSheetModalRefType>
  testID: string
  swapTransaction: SwapTransaction
  pool: EarnPosition
  token: TokenBalance
  tokenAmount: BigNumber
  parsedTokenAmount: BigNumber
}) {
  const { t } = useTranslation()
  const inputToken = useTokenInfo(pool.dataProps.depositTokenId)

  if (!inputToken) {
    // should never happen
    throw new Error(`Token info not found for token ID ${pool.dataProps.depositTokenId}`)
  }

  const swapToAmount = useMemo(
    () => getSwapToAmountInDecimals({ swapTransaction, fromAmount: tokenAmount }).toString(),
    [tokenAmount, swapTransaction]
  )

  const handleClose = () => forwardedRef.current?.close()

  return (
    <BottomSheet
      forwardedRef={forwardedRef}
      title={t('earnFlow.enterAmount.swapBottomSheet.swapDetails')}
      testId={testID}
    >
      <View style={styles.bottomSheetTextContent}>
        <View style={styles.gap8}>
          <View style={styles.bottomSheetLineItem} testID="SwapFrom">
            <Text style={styles.bottomSheetLineLabel}>
              {t('earnFlow.enterAmount.swapBottomSheet.swapFrom')}
            </Text>
            <Text style={styles.bottomSheetLineLabelText} testID="SwapFrom/Value">
              <TokenDisplay
                tokenId={token.tokenId}
                showLocalAmount={false}
                amount={parsedTokenAmount}
              />
              {' ('}
              <TokenDisplay tokenId={token.tokenId} amount={parsedTokenAmount} />
              {')'}
            </Text>
          </View>
          <View style={styles.bottomSheetLineItem} testID="SwapTo">
            <Text style={styles.bottomSheetLineLabel}>
              {t('earnFlow.enterAmount.swapBottomSheet.swapTo')}
            </Text>
            <Text style={styles.bottomSheetLineLabelText} testID="SwapTo/Value">
              <TokenDisplay
                tokenId={inputToken.tokenId}
                showLocalAmount={false}
                amount={swapToAmount}
              />
              {' ('}
              <TokenDisplay tokenId={inputToken.tokenId} amount={swapToAmount} />
              {')'}
            </Text>
          </View>
        </View>
        <View style={styles.bottomSheetDescriptionContainer}>
          <Text style={styles.bottomSheetDescriptionTitle}>
            {t('earnFlow.enterAmount.swapBottomSheet.whySwap')}
          </Text>
          <Text style={styles.bottomSheetDescriptionText}>
            {t('earnFlow.enterAmount.swapBottomSheet.swapDescription')}
          </Text>
        </View>
      </View>
      <Button
        onPress={handleClose}
        text={t('earnFlow.poolInfoScreen.infoBottomSheet.gotIt')}
        size={BtnSizes.FULL}
        type={BtnTypes.SECONDARY}
        testID="SwapDetailsBottomSheet/GotIt"
      />
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  safeAreaContainer: {
    flex: 1,
  },
  contentContainer: {
    paddingHorizontal: Spacing.Thick24,
    paddingTop: Spacing.Thick24,
    flexGrow: 1,
  },
  title: {
    ...typeScale.titleMedium,
    color: Colors.white,
    marginBottom: Spacing.Thick24,
  },
  inputContainer: {
    flex: 1,
  },
  continueButton: {
    paddingTop: Spacing.Thick24,
    marginTop: 'auto',
  },
  warning: {
    marginTop: Spacing.Regular16,
    paddingHorizontal: Spacing.Regular16,
    borderRadius: 16,
  },
  txDetailsContainer: {
    marginVertical: Spacing.Regular16,
    padding: Spacing.Regular16,
    backgroundColor: Colors.blue100,
    borderRadius: 12,
    gap: Spacing.Smallest8,
  },
  txDetailsLineItem: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  txDetailsValue: {
    flexShrink: 1,
    flexDirection: 'row',
    gap: Spacing.Tiny4,
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
  },
  txDetailsValueText: {
    ...typeScale.bodyMedium,
    color: Colors.white,
    flexWrap: 'wrap',
    textAlign: 'right',
  },
  gray4: {
    color: Colors.lightBlue,
  },
  gap8: {
    gap: Spacing.Smallest8,
  },
  bottomSheetDescriptionContainer: {
    gap: Spacing.Smallest8,
    marginTop: Spacing.Large32,
  },
  bottomSheetTextContent: {
    marginBottom: Spacing.XLarge48,
    marginTop: Spacing.Smallest8,
  },
  bottomSheetLineItem: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  bottomSheetLineLabel: {
    ...typeScale.bodySmall,
    maxWidth: '40%',
    textAlign: 'left',
  },
  bottomSheetLineLabelText: {
    ...typeScale.bodySmall,
    maxWidth: '60%',
    textAlign: 'right',
  },
  bottomSheetDescriptionTitle: {
    ...typeScale.labelSemiBoldSmall,
  },
  bottomSheetDescriptionText: {
    ...typeScale.bodySmall,
  },
  container: {
    marginBottom: Spacing.Large32,
  },
})
