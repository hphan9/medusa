import _ from "lodash"
import { BaseService } from "medusa-interfaces"
import { MedusaError } from "medusa-core-utils"

/**
 * Handles swaps
 * @implements BaseService
 */
class SwapService extends BaseService {
  static Events = {
    CREATED: "swap.created",
    RECEIVED: "swap.received",
    SHIPMENT_CREATED: "swap.shipment_created",
    PAYMENT_COMPLETED: "swap.payment_completed",
    PAYMENT_CAPTURED: "swap.payment_captured",
    PAYMENT_CAPTURE_FAILED: "swap.payment_capture_failed",
    PROCESS_REFUND_FAILED: "swap.process_refund_failed",
    REFUND_PROCESSED: "swap.refund_processed",
    FULFILLMENT_CREATED: "swap.fulfillment_created",
  }

  constructor({
    manager,
    swapRepository,
    eventBusService,
    cartService,
    totalsService,
    returnService,
    lineItemService,
    paymentProviderService,
    shippingOptionService,
    fulfillmentService,
    orderService,
    inventoryService,
    customShippingOptionService,
  }) {
    super()

    /** @private @const {EntityManager} */
    this.manager_ = manager

    /** @private @const {SwapModel} */
    this.swapRepository_ = swapRepository

    /** @private @const {TotalsService} */
    this.totalsService_ = totalsService

    /** @private @const {LineItemService} */
    this.lineItemService_ = lineItemService

    /** @private @const {ReturnService} */
    this.returnService_ = returnService

    /** @private @const {PaymentProviderService} */
    this.paymentProviderService_ = paymentProviderService

    /** @private @const {CartService} */
    this.cartService_ = cartService

    /** @private @const {FulfillmentService} */
    this.fulfillmentService_ = fulfillmentService

    /** @private @const {OrderService} */
    this.orderService_ = orderService

    /** @private @const {ShippingOptionService} */
    this.shippingOptionService_ = shippingOptionService

    /** @private @const {InventoryService} */
    this.inventoryService_ = inventoryService

    /** @private @const {EventBusService} */
    this.eventBus_ = eventBusService

    /** @private @const {CustomShippingOptionService} */
    this.customShippingOptionService_ = customShippingOptionService
  }

  withTransaction(transactionManager) {
    if (!transactionManager) {
      return this
    }

    const cloned = new SwapService({
      manager: transactionManager,
      swapRepository: this.swapRepository_,
      eventBusService: this.eventBus_,
      cartService: this.cartService_,
      totalsService: this.totalsService_,
      returnService: this.returnService_,
      lineItemService: this.lineItemService_,
      paymentProviderService: this.paymentProviderService_,
      shippingOptionService: this.shippingOptionService_,
      orderService: this.orderService_,
      inventoryService: this.inventoryService_,
      fulfillmentService: this.fulfillmentService_,
      customShippingOptionService: this.customShippingOptionService_,
    })

    cloned.transactionManager_ = transactionManager

    return cloned
  }

  transformQueryForTotals_(config) {
    let { select, relations } = config

    if (!select) {
      return {
        ...config,
        totalsToSelect: [],
      }
    }

    const totalFields = [
      "cart.subtotal",
      "cart.tax_total",
      "cart.shipping_total",
      "cart.discount_total",
      "cart.gift_card_total",
      "cart.total",
    ]

    const totalsToSelect = select.filter((v) => totalFields.includes(v))
    if (totalsToSelect.length > 0) {
      const relationSet = new Set(relations)
      relationSet.add("cart")
      relationSet.add("cart.items")
      relationSet.add("cart.gift_cards")
      relationSet.add("cart.discounts")
      relationSet.add("cart.discounts.rule")
      relationSet.add("cart.discounts.rule.valid_for")
      relationSet.add("cart.shipping_methods")
      relationSet.add("cart.region")
      relations = [...relationSet]

      select = select.filter((v) => !totalFields.includes(v))
    }

    return {
      ...config,
      relations,
      select,
      totalsToSelect,
    }
  }

  async decorateTotals_(cart, totalsFields = []) {
    if (totalsFields.includes("cart.shipping_total")) {
      cart.shipping_total = await this.totalsService_.getShippingTotal(cart)
    }
    if (totalsFields.includes("cart.discount_total")) {
      cart.discount_total = await this.totalsService_.getDiscountTotal(cart)
    }
    if (totalsFields.includes("cart.tax_total")) {
      cart.tax_total = await this.totalsService_.getTaxTotal(cart)
    }
    if (totalsFields.includes("cart.gift_card_total")) {
      cart.gift_card_total = await this.totalsService_.getGiftCardTotal(cart)
    }
    if (totalsFields.includes("cart.subtotal")) {
      cart.subtotal = await this.totalsService_.getSubtotal(cart)
    }
    if (totalsFields.includes("cart.total")) {
      cart.total = await this.totalsService_.getTotal(cart)
    }
    return cart
  }

  /**
   * Retrieves a swap with the given id.
   * @param {string} id - the id of the swap to retrieve
   * @return {Promise<Swap>} the swap
   */
  async retrieve(id, config = {}) {
    const swapRepo = this.manager_.getCustomRepository(this.swapRepository_)

    const validatedId = this.validateId_(id)

    const { totalsToSelect, ...newConfig } =
      this.transformQueryForTotals_(config)

    const query = this.buildQuery_({ id: validatedId }, newConfig)

    const rels = query.relations
    delete query.relations
    const swap = await swapRepo.findOneWithRelations(rels, query)

    if (!swap) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Swap was not found")
    }

    if (rels && rels.includes("cart")) {
      const cart = await this.decorateTotals_(swap.cart, totalsToSelect)
      swap.cart = cart
    }

    return swap
  }

  /**
   * Retrieves a swap based on its associated cart id
   * @param {string} cartId - the cart id that the swap's cart has
   * @return {Promise<Swap>} the swap
   */
  async retrieveByCartId(cartId, relations = []) {
    const swapRepo = this.manager_.getCustomRepository(this.swapRepository_)

    const swap = await swapRepo.findOne({
      where: {
        cart_id: cartId,
      },
      relations,
    })

    if (!swap) {
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "Swap was not found")
    }

    return swap
  }

  /**
   * @param {Object} selector - the query object for find
   * @return {Promise} the result of the find operation
   */
  list(
    selector,
    config = { skip: 0, take: 50, order: { created_at: "DESC" } }
  ) {
    const swapRepo = this.manager_.getCustomRepository(this.swapRepository_)
    const query = this.buildQuery_(selector, config)

    let rels = query.relations
    delete query.relations
    return swapRepo.findWithRelations(rels, query)
  }

  /**
   * @typedef OrderLike
   * @property {Array<LineItem>} items - the items on the order
   */

  /**
   * @typedef ReturnItem
   * @property {string} item_id - the id of the item in the order to return from.
   * @property {number} quantity - the amount of the item to return.
   */

  /**
   * Goes through a list of return items to ensure that they exist on the
   * original order. If the item exists it is verified that the quantity to
   * return is not higher than the original quantity ordered.
   * @param {OrderLike} order - the order to return from
   * @param {Array<ReturnItem>} returnItems - the items to return
   * @return {Array<ReturnItems>} the validated returnItems
   */
  validateReturnItems_(order, returnItems) {
    return returnItems.map(({ item_id, quantity }) => {
      const item = order.items.find((i) => i.id === item_id)

      // The item must exist in the order
      if (!item) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Item does not exist on order"
        )
      }

      // Item's cannot be returned multiple times
      if (item.quantity < item.returned_quantity + quantity) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Cannot return more items than have been ordered"
        )
      }

      return { item_id, quantity }
    })
  }

  /**
   * @typedef PreliminaryLineItem
   * @property {string} variant_id - the id of the variant to create an item from
   * @property {number} quantity - the amount of the variant to add to the line item
   */

  /**
   * Creates a swap from an order, with given return items, additional items
   * and an optional return shipping method.
   * @param {Order} order - the order to base the swap off.
   * @param {Array<ReturnItem>} returnItems - the items to return in the swap.
   * @param {Array<PreliminaryLineItem>} additionalItems - the items to send to
   *  the customer.
   * @param {ReturnShipping?} returnShipping - an optional shipping method for
   *  returning the returnItems.
   * @param {Object} custom - contains relevant custom information. This object may
   *  include no_notification which will disable sending notification when creating
   *  swap. If set, it overrules the attribute inherited from the order.
   * @returns {Promise<Swap>} the newly created swap.
   */
  async create(
    order,
    returnItems,
    additionalItems,
    returnShipping,
    custom = {
      no_notification: undefined,
    }
  ) {
    const { no_notification, ...rest } = custom
    return this.atomicPhase_(async (manager) => {
      if (
        order.fulfillment_status === "not_fulfilled" ||
        order.payment_status !== "captured"
      ) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Order cannot be swapped"
        )
      }

      for (const item of returnItems) {
        const line = await this.lineItemService_.retrieve(item.item_id, {
          relations: ["order", "swap", "claim_order"],
        })

        if (
          line.order?.canceled_at ||
          line.swap?.canceled_at ||
          line.claim_order?.canceled_at
        ) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            `Cannot create a swap on a canceled item.`
          )
        }
      }

      const newItems = await Promise.all(
        additionalItems.map(({ variant_id, quantity }) => {
          return this.lineItemService_.generate(
            variant_id,
            order.region_id,
            quantity
          )
        })
      )

      const evaluatedNoNotification =
        no_notification !== undefined ? no_notification : order.no_notification

      const swapRepo = manager.getCustomRepository(this.swapRepository_)
      const created = swapRepo.create({
        ...rest,
        fulfillment_status: "not_fulfilled",
        payment_status: "not_paid",
        order_id: order.id,
        additional_items: newItems,
        no_notification: evaluatedNoNotification,
      })

      const result = await swapRepo.save(created)

      await this.returnService_.withTransaction(manager).create({
        swap_id: result.id,
        order_id: order.id,
        items: returnItems,
        shipping_method: returnShipping,
        no_notification: evaluatedNoNotification,
      })

      await this.eventBus_
        .withTransaction(manager)
        .emit(SwapService.Events.CREATED, {
          id: result.id,
          no_notification: evaluatedNoNotification,
        })

      return result
    })
  }

  async processDifference(swapId) {
    return this.atomicPhase_(async (manager) => {
      const swap = await this.retrieve(swapId, {
        relations: ["payment", "order", "order.payments"],
      })

      if (swap.canceled_at) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Canceled swap cannot be processed"
        )
      }

      if (!swap.confirmed_at) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Cannot process a swap that hasn't been confirmed by the customer"
        )
      }

      const swapRepo = manager.getCustomRepository(this.swapRepository_)
      if (swap.difference_due < 0) {
        if (swap.payment_status === "difference_refunded") {
          return swap
        }

        try {
          await this.paymentProviderService_
            .withTransaction(manager)
            .refundPayment(
              swap.order.payments,
              -1 * swap.difference_due,
              "swap"
            )
        } catch (err) {
          swap.payment_status = "requires_action"
          const result = await swapRepo.save(swap)

          await this.eventBus_
            .withTransaction(manager)
            .emit(SwapService.Events.PROCESS_REFUND_FAILED, {
              id: result.id,
              no_notification: swap.no_notification,
            })

          return result
        }

        swap.payment_status = "difference_refunded"

        const result = await swapRepo.save(swap)

        await this.eventBus_
          .withTransaction(manager)
          .emit(SwapService.Events.REFUND_PROCESSED, {
            id: result.id,
            no_notification: swap.no_notification,
          })

        return result
      } else if (swap.difference_due === 0) {
        if (swap.payment_status === "difference_refunded") {
          return swap
        }

        swap.payment_status = "difference_refunded"

        const result = await swapRepo.save(swap)

        await this.eventBus_
          .withTransaction(manager)
          .emit(SwapService.Events.REFUND_PROCESSED, {
            id: result.id,
            no_notification: swap.no_notification,
          })

        return result
      }

      try {
        if (swap.payment_status === "captured") {
          return swap
        }

        await this.paymentProviderService_
          .withTransaction(manager)
          .capturePayment(swap.payment)
      } catch (err) {
        swap.payment_status = "requires_action"
        const result = await swapRepo.save(swap)

        await this.eventBus_
          .withTransaction(manager)
          .emit(SwapService.Events.PAYMENT_CAPTURE_FAILED, {
            id: swap.id,
            no_notification: swap.no_notification,
          })

        return result
      }

      swap.payment_status = "captured"

      const result = await swapRepo.save(swap)

      await this.eventBus_
        .withTransaction(manager)
        .emit(SwapService.Events.PAYMENT_CAPTURED, {
          id: result.id,
          no_notification: swap.no_notification,
        })

      return result
    })
  }

  async update(swapId, update) {
    return this.atomicPhase_(async (manager) => {
      const swap = await this.retrieve(swapId)

      if ("metadata" in update) {
        swap.metadata = this.setMetadata_(swap, update.metadata)
      }

      if ("no_notification" in update) {
        swap.no_notification = update.no_notification
      }

      if ("shipping_address" in update) {
        await this.updateShippingAddress_(swap, update.shipping_address)
      }

      const swapRepo = manager.getCustomRepository(this.swapRepository_)
      const result = await swapRepo.save(swap)
      return result
    })
  }

  /**
   * Creates a cart from the given swap and order. The cart can be used to pay
   * for differences associated with the swap. The swap represented by the
   * swapId must belong to the order. Fails if there is already a cart on the
   * swap.
   * @param {Order} order - the order to create the cart from
   * @param {string} swapId - the id of the swap to create the cart from
   * @returns {Promise<Swap>} the swap with its cart_id prop set to the id of
   *   the new cart.
   */
  async createCart(swapId, customShippingOptions = []) {
    return this.atomicPhase_(async (manager) => {
      const swap = await this.retrieve(swapId, {
        relations: [
          "order",
          "order.items",
          "order.swaps",
          "order.swaps.additional_items",
          "order.discounts",
          "order.discounts.rule",
          "order.claims",
          "order.claims.additional_items",
          "additional_items",
          "return_order",
          "return_order.items",
          "return_order.shipping_method",
        ],
      })

      if (swap.canceled_at) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Canceled swap cannot be used to create a cart"
        )
      }

      if (swap.cart_id) {
        throw new MedusaError(
          MedusaError.Types.DUPLICATE_ERROR,
          "A cart has already been created for the swap"
        )
      }

      const order = swap.order

      // filter out free shipping discounts
      const discounts =
        order?.discounts?.filter(({ rule }) => rule.type !== "free_shipping") ||
        undefined

      const cart = await this.cartService_.withTransaction(manager).create({
        discounts,
        email: order.email,
        billing_address_id: order.billing_address_id,
        shipping_address_id: order.shipping_address_id,
        region_id: order.region_id,
        customer_id: order.customer_id,
        type: "swap",
        metadata: {
          swap_id: swap.id,
          parent_order_id: order.id,
        },
      })

      for (const customShippingOption of customShippingOptions) {
        await this.customShippingOptionService_
          .withTransaction(manager)
          .create({
            cart_id: cart.id,
            shipping_option_id: customShippingOption.option_id,
            price: customShippingOption.price,
          })
      }

      for (const item of swap.additional_items) {
        await this.lineItemService_.withTransaction(manager).update(item.id, {
          cart_id: cart.id,
        })
      }

      // If the swap has a return shipping method the price has to be added to the
      // cart.
      if (swap.return_order && swap.return_order.shipping_method) {
        await this.lineItemService_.withTransaction(manager).create({
          cart_id: cart.id,
          title: "Return shipping",
          quantity: 1,
          has_shipping: true,
          allow_discounts: false,
          unit_price: swap.return_order.shipping_method.price,
          metadata: {
            is_return_line: true,
          },
        })
      }

      for (const r of swap.return_order.items) {
        let allItems = [...order.items]

        if (order.swaps && order.swaps.length) {
          for (const s of order.swaps) {
            allItems = [...allItems, ...s.additional_items]
          }
        }

        if (order.claims && order.claims.length) {
          for (const c of order.claims) {
            allItems = [...allItems, ...c.additional_items]
          }
        }

        const lineItem = allItems.find((i) => i.id === r.item_id)

        const toCreate = {
          cart_id: cart.id,
          thumbnail: lineItem.thumbnail,
          title: lineItem.title,
          variant_id: lineItem.variant_id,
          unit_price: -1 * lineItem.unit_price,
          quantity: r.quantity,
          allow_discounts: lineItem.allow_discounts,
          metadata: {
            ...lineItem.metadata,
            is_return_line: true,
          },
        }

        await this.lineItemService_.withTransaction(manager).create(toCreate)
      }

      swap.cart_id = cart.id

      const swapRepo = manager.getCustomRepository(this.swapRepository_)
      const result = await swapRepo.save(swap)
      return result
    })
  }

  /**
   *
   */
  async registerCartCompletion(swapId) {
    return this.atomicPhase_(async (manager) => {
      const swap = await this.retrieve(swapId, {
        relations: [
          "cart",
          "cart.region",
          "cart.shipping_methods",
          "cart.shipping_address",
          "cart.items",
          "cart.discounts",
          "cart.discounts.rule",
          "cart.payment",
          "cart.gift_cards",
        ],
      })

      // If we already registered the cart completion we just return
      if (swap.confirmed_at) {
        return swap
      }

      if (swap.canceled_at) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Cart related to canceled swap cannot be completed"
        )
      }

      const cart = swap.cart
      const { payment } = cart

      const items = swap.cart.items

      if (!swap.allow_backorder) {
        for (const item of items) {
          try {
            await this.inventoryService_
              .withTransaction(manager)
              .confirmInventory(item.variant_id, item.quantity)
          } catch (err) {
            if (payment) {
              await this.paymentProviderService_
                .withTransaction(manager)
                .cancelPayment(payment)
            }
            await this.cartService_
              .withTransaction(manager)
              .update(cart.id, { payment_authorized_at: null })
            throw err
          }
        }
      }

      const total = await this.totalsService_.getTotal(cart)

      if (total > 0) {
        if (!payment) {
          throw new MedusaError(
            MedusaError.Types.INVALID_ARGUMENT,
            "Cart does not contain a payment"
          )
        }

        const paymentStatus = await this.paymentProviderService_
          .withTransaction(manager)
          .getStatus(payment)

        // If payment status is not authorized, we throw
        if (paymentStatus !== "authorized" && paymentStatus !== "succeeded") {
          throw new MedusaError(
            MedusaError.Types.INVALID_ARGUMENT,
            "Payment method is not authorized"
          )
        }

        await this.paymentProviderService_
          .withTransaction(manager)
          .updatePayment(payment.id, {
            swap_id: swapId,
            order_id: swap.order_id,
          })

        for (const item of items) {
          await this.inventoryService_
            .withTransaction(manager)
            .adjustInventory(item.variant_id, -item.quantity)
        }
      }

      const now = new Date()
      swap.difference_due = total
      swap.shipping_address_id = cart.shipping_address_id
      swap.shipping_methods = cart.shipping_methods
      swap.confirmed_at = now.toISOString()
      swap.payment_status = total === 0 ? "confirmed" : "awaiting"

      const swapRepo = manager.getCustomRepository(this.swapRepository_)
      const result = await swapRepo.save(swap)

      for (const method of cart.shipping_methods) {
        await this.shippingOptionService_
          .withTransaction(manager)
          .updateShippingMethod(method.id, {
            swap_id: result.id,
          })
      }

      this.eventBus_
        .withTransaction(manager)
        .emit(SwapService.Events.PAYMENT_COMPLETED, {
          id: swap.id,
          no_notification: swap.no_notification,
        })

      await this.cartService_
        .withTransaction(manager)
        .update(cart.id, { completed_at: new Date() })

      return result
    })
  }

  /**
   * Registers the return associated with a swap as received. If the return
   * is received with mismatching return items the swap's status will be updated
   * to requires_action.
   * @param {Order} order - the order to receive the return based off
   * @param {string} swapId - the id of the swap to receive.
   * @param {Array<ReturnItem>} - the items that have been returned
   * @returns {Promise<Swap>} the resulting swap, with an updated return and
   *   status.
   */
  async receiveReturn(swapId, returnItems) {
    return this.atomicPhase_(async (manager) => {
      const swap = await this.retrieve(swapId, { relations: ["return_order"] })

      if (swap.canceled_at) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Canceled swap cannot be registered as received"
        )
      }

      const returnId = swap.return_order && swap.return_order.id
      if (!returnId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Swap has no return request"
        )
      }

      const updatedRet = await this.returnService_
        .withTransaction(manager)
        .receiveReturn(returnId, returnItems, undefined, false)

      if (updatedRet.status === "requires_action") {
        const swapRepo = manager.getCustomRepository(this.swapRepository_)
        swap.fulfillment_status = "requires_action"
        const result = await swapRepo.save(swap)
        return result
      }

      return this.retrieve(swapId)
    })
  }

  /**
   * Cancels a given swap if possible. A swap can only be canceled if all
   * related returns, fulfillments, and payments have been canceled. If a swap
   * is associated with a refund, it cannot be canceled.
   * @param {string} swapId - the id of the swap to cancel.
   * @returns {Promise<Swap>} the canceled swap.
   */
  async cancel(swapId) {
    return this.atomicPhase_(async (manager) => {
      const swap = await this.retrieve(swapId, {
        relations: ["payment", "fulfillments", "return_order"],
      })

      if (
        swap.payment_status === "difference_refunded" ||
        swap.payment_status === "partially_refunded" ||
        swap.payment_status === "refunded"
      ) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Swap with a refund cannot be canceled"
        )
      }

      if (swap.fulfillments) {
        for (const f of swap.fulfillments) {
          if (!f.canceled_at) {
            throw new MedusaError(
              MedusaError.Types.NOT_ALLOWED,
              "All fulfillments must be canceled before the swap can be canceled"
            )
          }
        }
      }

      if (swap.return_order && swap.return_order.status !== "canceled") {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Return must be canceled before the swap can be canceled"
        )
      }

      swap.payment_status = "canceled"
      swap.fulfillment_status = "canceled"
      swap.canceled_at = new Date()

      if (swap.payment) {
        await this.paymentProviderService_
          .withTransaction(manager)
          .cancelPayment(swap.payment)
      }

      const swapRepo = manager.getCustomRepository(this.swapRepository_)
      const result = await swapRepo.save(swap)
      return result
    })
  }

  /**
   * Fulfills the addtional items associated with the swap. Will call the
   * fulfillment providers associated with the shipping methods.
   * @param {string} swapId - the id of the swap to fulfill,
   * @param {object} config - optional configurations, includes optional metadata to attach to the shipment, and a no_notification flag.
   * @returns {Promise<Swap>} the updated swap with new status and fulfillments.
   */
  async createFulfillment(
    swapId,
    config = {
      metadata: {},
      no_notification: undefined,
    }
  ) {
    const { metadata, no_notification } = config

    return this.atomicPhase_(async (manager) => {
      const swap = await this.retrieve(swapId, {
        relations: [
          "payment",
          "shipping_address",
          "additional_items",
          "shipping_methods",
          "order",
          "order.billing_address",
          "order.discounts",
          "order.discounts.rule",
          "order.payments",
        ],
      })
      const order = swap.order

      if (swap.canceled_at) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Canceled swap cannot be fulfilled"
        )
      }

      if (
        swap.fulfillment_status !== "not_fulfilled" &&
        swap.fulfillment_status !== "canceled"
      ) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "The swap was already fulfilled"
        )
      }

      if (!swap.shipping_methods?.length) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Cannot fulfill an swap that doesn't have shipping methods"
        )
      }

      const evaluatedNoNotification =
        no_notification !== undefined ? no_notification : swap.no_notification

      swap.fulfillments = await this.fulfillmentService_
        .withTransaction(manager)
        .createFulfillment(
          {
            ...swap,
            payments: swap.payment ? [swap.payment] : order.payments,
            email: order.email,
            discounts: order.discounts,
            currency_code: order.currency_code,
            tax_rate: order.tax_rate,
            region_id: order.region_id,
            display_id: order.display_id,
            billing_address: order.billing_address,
            items: swap.additional_items,
            shipping_methods: swap.shipping_methods,
            is_swap: true,
            no_notification: evaluatedNoNotification,
          },
          swap.additional_items.map((i) => ({
            item_id: i.id,
            quantity: i.quantity,
          })),
          { swap_id: swapId, metadata }
        )

      let successfullyFulfilled = []
      for (const f of swap.fulfillments) {
        successfullyFulfilled = successfullyFulfilled.concat(f.items)
      }

      swap.fulfillment_status = "fulfilled"

      // Update all line items to reflect fulfillment
      for (const item of swap.additional_items) {
        const fulfillmentItem = successfullyFulfilled.find(
          (f) => item.id === f.item_id
        )

        if (fulfillmentItem) {
          const fulfilledQuantity =
            (item.fulfilled_quantity || 0) + fulfillmentItem.quantity

          // Update the fulfilled quantity
          await this.lineItemService_.withTransaction(manager).update(item.id, {
            fulfilled_quantity: fulfilledQuantity,
          })

          if (item.quantity !== fulfilledQuantity) {
            swap.fulfillment_status = "requires_action"
          }
        } else {
          if (item.quantity !== item.fulfilled_quantity) {
            swap.fulfillment_status = "requires_action"
          }
        }
      }

      const swapRepo = manager.getCustomRepository(this.swapRepository_)
      const result = await swapRepo.save(swap)

      await this.eventBus_.withTransaction(manager).emit(
        SwapService.Events.FULFILLMENT_CREATED,

        {
          id: swapId,
          fulfillment_id: result.id,
          no_notification: evaluatedNoNotification,
        }
      )

      return result
    })
  }

  /**
   * Cancels a fulfillment (if related to a swap)
   * @param {string} fulfillmentId - the ID of the fulfillment to cancel
   * @returns updated swap
   */
  async cancelFulfillment(fulfillmentId) {
    return this.atomicPhase_(async (manager) => {
      const canceled = await this.fulfillmentService_
        .withTransaction(manager)
        .cancelFulfillment(fulfillmentId)

      if (!canceled.swap_id) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          `Fufillment not related to a swap`
        )
      }

      const swap = await this.retrieve(canceled.swap_id)

      swap.fulfillment_status = "canceled"

      const swapRepo = manager.getCustomRepository(this.swapRepository_)
      const updated = await swapRepo.save(swap)
      return updated
    })
  }

  /**
   * Marks a fulfillment as shipped and attaches tracking numbers.
   * @param {string} swapId - the id of the swap that has been shipped.
   * @param {string} fulfillmentId - the id of the specific fulfillment that
   *   has been shipped
   * @param {TrackingLink[]} trackingLinks - the tracking numbers associated
   *   with the shipment
   * @param {object} config - optional configurations, includes optional metadata to attach to the shipment, and a noNotification flag.
   * @returns {Promise<Swap>} the updated swap with new fulfillments and status.
   */
  async createShipment(
    swapId,
    fulfillmentId,
    trackingLinks,
    config = {
      metadata: {},
      no_notification: undefined,
    }
  ) {
    const { metadata, no_notification } = config

    return this.atomicPhase_(async (manager) => {
      const swap = await this.retrieve(swapId, {
        relations: ["additional_items"],
      })

      if (swap.canceled_at) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Canceled swap cannot be fulfilled as shipped"
        )
      }
      const evaluatedNoNotification =
        no_notification !== undefined ? no_notification : swap.no_notification

      // Update the fulfillment to register
      const shipment = await this.fulfillmentService_
        .withTransaction(manager)
        .createShipment(fulfillmentId, trackingLinks, {
          metadata,
          no_notification: evaluatedNoNotification,
        })

      swap.fulfillment_status = "shipped"

      // Go through all the additional items in the swap
      for (const i of swap.additional_items) {
        const shipped = shipment.items.find((si) => si.item_id === i.id)
        if (shipped) {
          const shippedQty = (i.shipped_quantity || 0) + shipped.quantity
          await this.lineItemService_.withTransaction(manager).update(i.id, {
            shipped_quantity: shippedQty,
          })

          if (shippedQty !== i.quantity) {
            swap.fulfillment_status = "partially_shipped"
          }
        } else {
          if (i.shipped_quantity !== i.quantity) {
            swap.fulfillment_status = "partially_shipped"
          }
        }
      }

      const swapRepo = manager.getCustomRepository(this.swapRepository_)
      const result = await swapRepo.save(swap)
      await this.eventBus_
        .withTransaction(manager)
        .emit(SwapService.Events.SHIPMENT_CREATED, {
          id: swapId,
          fulfillment_id: shipment.id,
          no_notification: swap.no_notification,
        })
      return result
    })
  }

  /**
   * Dedicated method to delete metadata for a swap.
   * @param {string} swapId - the order to delete metadata from.
   * @param {string} key - key for metadata field
   * @return {Promise} resolves to the updated result.
   */
  async deleteMetadata(swapId, key) {
    const validatedId = this.validateId_(swapId)

    if (typeof key !== "string") {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Key type is invalid. Metadata keys must be strings"
      )
    }

    const keyPath = `metadata.${key}`
    return this.swapModel_
      .updateOne({ _id: validatedId }, { $unset: { [keyPath]: "" } })
      .catch((err) => {
        throw new MedusaError(MedusaError.Types.DB_ERROR, err.message)
      })
  }

  /**
   * Registers the swap return items as received so that they cannot be used
   * as a part of other swaps/returns.
   * @param {string} id - the id of the order with the swap.
   * @param {string} swapId - the id of the swap that has been received.
   * @returns {Promise<Order>} the resulting order
   */
  async registerReceived(id) {
    return this.atomicPhase_(async (manager) => {
      const swap = await this.retrieve(id, {
        relations: ["return_order", "return_order.items"],
      })

      if (swap.canceled_at) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Canceled swap cannot be registered as received"
        )
      }

      if (swap.return_order.status !== "received") {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Swap is not received"
        )
      }

      const result = await this.retrieve(id)

      await this.eventBus_
        .withTransaction(manager)
        .emit(SwapService.Events.RECEIVED, {
          id: id,
          order_id: result.order_id,
          no_notification: swap.no_notification,
        })

      return result
    })
  }
}

export default SwapService
