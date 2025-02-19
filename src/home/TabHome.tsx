import { NativeStackScreenProps } from '@react-navigation/native-stack'
import BigNumber from 'bignumber.js'
import _ from 'lodash'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutChangeEvent, StyleSheet, Text, View } from 'react-native'
import PieChart, { Slice } from 'react-native-pie-chart'
import Animated, {
  interpolateColor,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { showMessage } from 'src/alert/actions'
import AppAnalytics from 'src/analytics/AppAnalytics'
import { EarnEvents } from 'src/analytics/Events'
import { AppState } from 'src/app/actions'
import { appStateSelector, phoneNumberVerifiedSelector } from 'src/app/selectors'
import { BottomSheetModalRefType } from 'src/components/BottomSheet'
import Button, { BtnSizes, BtnTypes } from 'src/components/Button'
import {
  ALERT_BANNER_DURATION,
  DEFAULT_TESTNET,
  SHOW_TESTNET_BANNER,
  TIME_UNTIL_TOKEN_INFO_BECOMES_STALE,
} from 'src/config'
import PoolList from 'src/earn/PoolList'
import { EarnTabType } from 'src/earn/types'
import { getEarnPositionBalanceValues } from 'src/earn/utils'
import { refreshAllBalances, visitHome } from 'src/home/actions'
import AttentionIcon from 'src/icons/Attention'
import ShakingCowHead from 'src/icons/ShakingCowHead'
import { importContacts } from 'src/identity/actions'
import { getLocalCurrencySymbol } from 'src/localCurrency/selectors'
import { navigate } from 'src/navigator/NavigationService'
import { Screens } from 'src/navigator/Screens'
import { StackParamList } from 'src/navigator/types'
import { refreshPositions } from 'src/positions/actions'
import {
  earnPositionsSelector,
  positionsFetchedAtSelector,
  positionsStatusSelector,
} from 'src/positions/selectors'
import { phoneRecipientCacheSelector } from 'src/recipients/reducer'
import { useDispatch, useSelector } from 'src/redux/hooks'
import { initializeSentryUserContext } from 'src/sentry/actions'
import Colors from 'src/styles/colors'
import { typeScale } from 'src/styles/fonts'
import { Spacing } from 'src/styles/styles'
import { useTotalTokenBalance } from 'src/tokens/hooks'
import { tokensByIdSelector } from 'src/tokens/selectors'
import { TokenBalance } from 'src/tokens/slice'
import { hasGrantedContactsPermission } from 'src/utils/contacts'

type Props = NativeStackScreenProps<StackParamList, Screens.TabHome>

function TabHome({ navigation, route }: Props) {
  const { t } = useTranslation()

  const appState = useSelector(appStateSelector)
  const recipientCache = useSelector(phoneRecipientCacheSelector)
  const isNumberVerified = useSelector(phoneNumberVerifiedSelector)

  const dispatch = useDispatch()

  const pools = useSelector(earnPositionsSelector)

  const activeTab = route.params?.activeEarnTab ?? EarnTabType.AllPools

  const insets = useSafeAreaInsets()

  const supportedNetworkIds = [...new Set(pools.map((pool) => pool.networkId))]
  const allTokens = useSelector((state) => tokensByIdSelector(state, supportedNetworkIds))

  // Scroll Aware Header
  const scrollPosition = useSharedValue(0)
  const [listHeaderHeight, setListHeaderHeight] = useState(0)
  const [nonStickyHeaderHeight, setNonStickyHeaderHeight] = useState(0)

  const animatedListHeaderStyles = useAnimatedStyle(() => {
    if (nonStickyHeaderHeight === 0) {
      return {
        shadowColor: 'transparent',
        transform: [
          {
            translateY: -scrollPosition.value,
          },
        ],
      }
    }

    return {
      transform: [
        {
          translateY:
            scrollPosition.value > nonStickyHeaderHeight
              ? -nonStickyHeaderHeight
              : -scrollPosition.value,
        },
      ],
      shadowColor: interpolateColor(
        scrollPosition.value,
        [nonStickyHeaderHeight - 10, nonStickyHeaderHeight + 10],
        ['transparent', Colors.blue100]
      ),
    }
  }, [scrollPosition.value, nonStickyHeaderHeight])

  const learnMoreBottomSheetRef = useRef<BottomSheetModalRefType>(null)

  useEffect(() => {
    dispatch(visitHome())
  }, [])

  const showTestnetBanner = () => {
    dispatch(
      showMessage(
        t('testnetAlert.1', { testnet: _.startCase(DEFAULT_TESTNET) }),
        ALERT_BANNER_DURATION,
        null,
        null,
        t('testnetAlert.0', { testnet: _.startCase(DEFAULT_TESTNET) })
      )
    )
  }

  const tryImportContacts = async () => {
    // Skip if contacts have already been imported or the user hasn't verified their phone number.
    if (Object.keys(recipientCache).length || !isNumberVerified) {
      return
    }

    const contactPermissionStatusGranted = await hasGrantedContactsPermission()
    if (contactPermissionStatusGranted) {
      dispatch(importContacts())
    }
  }

  useEffect(() => {
    // TODO find a better home for this, its unrelated to wallet home
    dispatch(initializeSentryUserContext())
    if (SHOW_TESTNET_BANNER) {
      showTestnetBanner()
    }

    // Waiting 1/2 sec before triggering to allow
    // rest of feed to load unencumbered
    setTimeout(tryImportContacts, 500)
  }, [])

  useEffect(() => {
    if (appState === AppState.Active) {
      dispatch(refreshAllBalances())
    }
  }, [appState])

  const tokens = [...new Set(pools.flatMap((pool) => pool.tokens))]

  const tokenList = useMemo(() => {
    return tokens
      .map((token) => allTokens[token.tokenId])
      .filter((token): token is TokenBalance => !!token)
  }, [allTokens])

  const handleMeasureListHeadereHeight = (event: LayoutChangeEvent) => {
    setListHeaderHeight(event.nativeEvent.layout.height)
  }

  const handleScroll = useAnimatedScrollHandler((event) => {
    scrollPosition.value = event.contentOffset.y
  })

  const handleMeasureNonStickyHeaderHeight = (event: LayoutChangeEvent) => {
    setNonStickyHeaderHeight(event.nativeEvent.layout.height)
  }

  const handleChangeActiveView = (selectedTab: EarnTabType) => {
    navigation.setParams({ activeEarnTab: selectedTab })
  }

  const displayPools = useMemo(() => {
    const returnPools = pools.filter(
      (pool) => new BigNumber(pool.balance).gt(0) && !!allTokens[pool.dataProps.depositTokenId]
    )
    return returnPools.filter((pool) =>
      pool.tokens.some((poolToken) =>
        tokenList.map((token) => token.tokenId).includes(poolToken.tokenId)
      )
    )
  }, [pools, allTokens, activeTab, tokenList])

  const onPressLearnMore = () => {
    AppAnalytics.track(EarnEvents.earn_home_learn_more_press)
    learnMoreBottomSheetRef.current?.snapToIndex(0)
  }

  const onPressTryAgain = () => {
    AppAnalytics.track(EarnEvents.earn_home_error_try_again)
    dispatch(refreshPositions())
  }

  const onPressInvest = () => {
    navigate(Screens.InvestEnterAmount)
  }

  const totalTokenBalanceLocal = useTotalTokenBalance()
  const localCurrencySymbol = useSelector(getLocalCurrencySymbol)

  const positionsStatus = useSelector(positionsStatusSelector)
  const positionsFetchedAt = useSelector(positionsFetchedAtSelector)
  const errorLoadingPools =
    positionsStatus === 'error' &&
    (pools.length === 0 ||
      Date.now() - (positionsFetchedAt ?? 0) > TIME_UNTIL_TOKEN_INFO_BECOMES_STALE)

  const zeroPoolsInMyPoolsTab =
    !errorLoadingPools && displayPools.length === 0 && activeTab === EarnTabType.MyPools

  const colors = [Colors.primary, Colors.blue100, Colors.accent, Colors.gray5]
  const series: Slice[] = displayPools.map((pool, index) => {
    const { poolBalanceInUsd } = getEarnPositionBalanceValues({ pool })

    const rewardAmount = pool.dataProps.earningItems.reduce(
      (acc, earnItem) =>
        acc.plus(
          new BigNumber(earnItem.amount).times(
            allTokens[earnItem.tokenId]?.priceUsd ?? new BigNumber(0)
          )
        ),
      new BigNumber(0)
    )
    return {
      value: rewardAmount.plus(poolBalanceInUsd).toNumber(),
      color: colors[index],
      label: {
        text: `${pool.displayProps.title} ${pool.displayProps.description}`,
        ...typeScale.labelSemiBoldSmall,
        fill: Colors.white,
      },
    }
  })
  const totalPoolValue = new BigNumber(series.reduce((acc, slice) => acc + slice.value, 0))
  return (
    <>
      <Animated.ScrollView testID="Home" style={styles.container}>
        {series.length === 0 && (
          <>
            <View style={styles.textContainer}>
              <Text
                style={styles.title}
              >{`You have ${localCurrencySymbol}${totalTokenBalanceLocal?.toFormat(2)} of coins sitting around`}</Text>
              <ShakingCowHead />
            </View>
            <View>
              <Button
                onPress={onPressInvest}
                text={'Invest'}
                type={BtnTypes.SECONDARY}
                size={BtnSizes.FULL}
              />
            </View>
          </>
        )}
        {series.length > 0 && (
          <View style={styles.textContainer}>
            <Text
              style={styles.title}
            >{`${localCurrencySymbol}${totalPoolValue?.toFormat(2)} Invested`}</Text>
            <PieChart widthAndHeight={200} series={series} />
          </View>
        )}
        {errorLoadingPools && (
          <View style={styles.textContainerError}>
            <View style={{ alignItems: 'center' }}>
              <AttentionIcon size={48} color={Colors.white} />
            </View>
            <Text style={styles.errorTitle}>{t('earnFlow.home.errorTitle')}</Text>
            <Text style={styles.description}>{t('earnFlow.home.errorDescription')}</Text>
            <Button
              onPress={onPressTryAgain}
              text={t('earnFlow.home.errorButton')}
              type={BtnTypes.SECONDARY}
              size={BtnSizes.FULL}
            />
          </View>
        )}
        {zeroPoolsInMyPoolsTab && (
          <View style={styles.textContainer}>
            <ShakingCowHead />
            <Text style={styles.noPoolsTitle}>{t('earnFlow.home.noPoolsTitle')}</Text>
            <Text style={styles.description}>{t('earnFlow.home.noPoolsDescription')}</Text>
          </View>
        )}
        {!errorLoadingPools && !zeroPoolsInMyPoolsTab && (
          <>
            <PoolList
              handleScroll={handleScroll}
              listHeaderHeight={0}
              paddingBottom={insets.bottom}
              displayPools={displayPools}
              onPressLearnMore={onPressLearnMore}
            />
            {series.length > 0 && (
              <Button
                onPress={onPressInvest}
                text={'Invest More'}
                type={BtnTypes.PRIMARY}
                size={BtnSizes.FULL}
                style={{ marginHorizontal: Spacing.Regular16 }}
              />
            )}
          </>
        )}
      </Animated.ScrollView>
    </>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  title: {
    ...typeScale.titleLarge,
  },
  textContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    textAlign: 'center',
    backgroundColor: Colors.background,
    padding: Spacing.Regular16,
  },
  textContainerError: {
    flex: 1,
    justifyContent: 'center',
    padding: Spacing.Thick24,
    backgroundColor: Colors.background,
  },
  noPoolsTitle: {
    ...typeScale.labelSemiBoldLarge,
    textAlign: 'center',
  },
  errorTitle: {
    ...typeScale.labelSemiBoldLarge,
    textAlign: 'center',
    marginTop: Spacing.Regular16,
  },
  description: {
    ...typeScale.bodySmall,
    textAlign: 'center',
    marginVertical: Spacing.Regular16,
  },
})

export default TabHome
